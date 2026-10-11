import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const transitionalModelUrl = new URL("../cost/dev-us-east-1.json", import.meta.url);
const idleModelUrl = new URL("../cost/dev-idle-us-east-1.json", import.meta.url);
const connectorModelUrl = new URL(
  "../cost/dev-connection-verifier-us-east-1.json",
  import.meta.url
);
const sourceArchiverModelUrl = new URL(
  "../cost/dev-source-archiver-us-east-1.json",
  import.meta.url
);
const coordinatorModelUrl = new URL(
  "../cost/dev-observable-coordinator-us-east-1.json",
  import.meta.url
);
const combinedPrivateRuntimesModelUrl = new URL(
  "../cost/dev-worker-observable-combined-us-east-1.json",
  import.meta.url
);
const transitionalModel = JSON.parse(await readFile(transitionalModelUrl, "utf8"));
const idleModel = JSON.parse(await readFile(idleModelUrl, "utf8"));
const connectorModel = JSON.parse(await readFile(connectorModelUrl, "utf8"));
const sourceArchiverModel = JSON.parse(
  await readFile(sourceArchiverModelUrl, "utf8")
);
const coordinatorModel = JSON.parse(await readFile(coordinatorModelUrl, "utf8"));
const combinedPrivateRuntimesModel = JSON.parse(
  await readFile(combinedPrivateRuntimesModelUrl, "utf8")
);

function calculate(model) {
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.currency, "USD");
  assert.ok(Array.isArray(model.items) && model.items.length > 0);

  const rows = model.items.map((item) => {
    for (const field of ["quantity", "rateUsd"]) {
      assert.equal(typeof item[field], "number", `${item.id}.${field} must be numeric`);
      assert.ok(item[field] >= 0, `${item.id}.${field} cannot be negative`);
    }
    assert.ok(model.sources[item.source], `${item.id} has an unknown source`);
    return {...item, monthlyUsd: item.quantity * item.rateUsd};
  });

  return {
    rows,
    totalMonthlyUsd: rows.reduce((total, row) => total + row.monthlyUsd, 0),
    foundationMonthlyUsd: rows
      .filter((row) => row.scope === "foundation")
      .reduce((total, row) => total + row.monthlyUsd, 0),
    apiMonthlyUsd: rows
      .filter((row) => row.scope === "api")
      .reduce((total, row) => total + row.monthlyUsd, 0),
    workerMonthlyUsd: rows
      .filter((row) => row.scope === "worker")
      .reduce((total, row) => total + row.monthlyUsd, 0)
  };
}

const transitional = calculate(transitionalModel);
const idle = calculate(idleModel);
const connector = calculate(connectorModel);
const sourceArchiver = calculate(sourceArchiverModel);
const coordinator = calculate(coordinatorModel);
const combinedPrivateRuntimes = calculate(combinedPrivateRuntimesModel);
const transitionalHeadroomUsd =
  transitionalModel.budgetMonthlyUsd - transitional.totalMonthlyUsd;
const maxRotationMonthlyUsd =
  idle.totalMonthlyUsd + idleModel.maxPaidKmsRotations;
const connectorCombinedMonthlyUsd = idle.totalMonthlyUsd + connector.totalMonthlyUsd;
const connectorRotationMonthlyUsd = maxRotationMonthlyUsd + connector.totalMonthlyUsd;
const sourceArchiverCombinedMonthlyUsd =
  idle.totalMonthlyUsd + sourceArchiver.totalMonthlyUsd;
const sourceArchiverRotationMonthlyUsd =
  maxRotationMonthlyUsd + sourceArchiver.totalMonthlyUsd;
const coordinatorCombinedMonthlyUsd = idle.totalMonthlyUsd + coordinator.totalMonthlyUsd;
const coordinatorRotationMonthlyUsd = maxRotationMonthlyUsd + coordinator.totalMonthlyUsd;
const combinedPrivateRuntimesCurrentMonthlyUsd =
  idle.totalMonthlyUsd + combinedPrivateRuntimes.totalMonthlyUsd;
const combinedPrivateRuntimesRotationMonthlyUsd =
  maxRotationMonthlyUsd + combinedPrivateRuntimes.totalMonthlyUsd;

if (process.argv.includes("--check")) {
  assert.equal(transitionalModel.satisfiesIdleTarget, false);
  assert.equal(transitionalModel.provisionalIdleTargetUsd, 5);
  assert.ok(
    Math.abs(transitional.totalMonthlyUsd - transitionalModel.expectedMonthlyUsd) < 0.005,
    `transitional expected $${transitionalModel.expectedMonthlyUsd}, calculated $${transitional.totalMonthlyUsd.toFixed(2)}`
  );
  assert.ok(transitionalHeadroomUsd > 0, "the modeled dev bill exceeds its budget");
  assert.ok(
    transitionalModel.budgetMonthlyUsd / transitional.totalMonthlyUsd >= 1.2,
    "the budget must retain at least 20% modeled headroom"
  );
  assert.equal(idleModel.satisfiesIdleTarget, true);
  assert.ok(Array.isArray(idleModel.forbiddenFixedIdleResources));
  assert.ok(idleModel.forbiddenFixedIdleResources.length > 0);
  assert.ok(
    Math.abs(idle.totalMonthlyUsd - idleModel.expectedMonthlyUsd) < 0.005,
    `idle expected $${idleModel.expectedMonthlyUsd}, calculated $${idle.totalMonthlyUsd.toFixed(2)}`
  );
  assert.ok(
    Math.abs(maxRotationMonthlyUsd - idleModel.maxRotationExpectedMonthlyUsd) < 0.005,
    `rotation-sensitive idle expected $${idleModel.maxRotationExpectedMonthlyUsd}, calculated $${maxRotationMonthlyUsd.toFixed(2)}`
  );
  assert.ok(
    maxRotationMonthlyUsd < idleModel.idleTargetMonthlyUsd,
    "the zero-request model must stay below its cap after two paid KMS rotations"
  );
  for (const addOn of idleModel.linearRetainedDataRates) {
    assert.equal(typeof addOn.rateUsd, "number");
    assert.ok(addOn.rateUsd >= 0);
    assert.ok(idleModel.sources[addOn.source], `${addOn.description} has an unknown source`);
  }
  assert.ok(
    Math.abs(connector.totalMonthlyUsd - connectorModel.expectedMonthlyUsd) < 0.005,
    "optional connector fixed cost does not match its checked expectation"
  );
  assert.ok(
    Math.abs(
      connectorCombinedMonthlyUsd - connectorModel.combinedCurrentMonthlyUsd
    ) < 0.005
  );
  assert.ok(
    Math.abs(
      connectorRotationMonthlyUsd
        - connectorModel.combinedAfterTwoKmsRotationsMonthlyUsd
    ) < 0.005
  );
  assert.ok(connectorRotationMonthlyUsd > idleModel.idleTargetMonthlyUsd);
  assert.ok(connectorRotationMonthlyUsd < connectorModel.budgetMonthlyUsd);
  assert.ok(
    Math.abs(sourceArchiver.totalMonthlyUsd - sourceArchiverModel.expectedMonthlyUsd) < 0.005,
    "optional source archiver fixed cost does not match its checked expectation"
  );
  assert.ok(
    Math.abs(
      sourceArchiverCombinedMonthlyUsd
        - sourceArchiverModel.combinedCurrentMonthlyUsd
    ) < 0.005
  );
  assert.ok(
    Math.abs(
      sourceArchiverRotationMonthlyUsd
        - sourceArchiverModel.combinedAfterTwoKmsRotationsMonthlyUsd
    ) < 0.005
  );
  assert.ok(sourceArchiverRotationMonthlyUsd > idleModel.idleTargetMonthlyUsd);
  assert.ok(sourceArchiverRotationMonthlyUsd < sourceArchiverModel.budgetMonthlyUsd);
  assert.ok(
    Math.abs(coordinator.totalMonthlyUsd - coordinatorModel.expectedMonthlyUsd) < 0.005,
    "optional coordinator fixed cost does not match its checked expectation"
  );
  assert.ok(
    Math.abs(coordinatorCombinedMonthlyUsd - coordinatorModel.combinedCurrentMonthlyUsd) < 0.005
  );
  assert.ok(
    Math.abs(
      coordinatorRotationMonthlyUsd
        - coordinatorModel.combinedAfterTwoKmsRotationsMonthlyUsd
    ) < 0.005
  );
  assert.ok(coordinatorRotationMonthlyUsd > idleModel.idleTargetMonthlyUsd);
  assert.ok(coordinatorRotationMonthlyUsd < coordinatorModel.budgetMonthlyUsd);
  assert.equal(
    coordinatorModel.items.find((item) => item.id === "coordinator-interface-endpoints")
      ?.quantity,
    3 * 730
  );
  assert.ok(
    Math.abs(
      combinedPrivateRuntimes.totalMonthlyUsd
        - combinedPrivateRuntimesModel.expectedMonthlyUsd
    ) < 0.005,
    "combined private-runtime fixed cost does not match its checked expectation"
  );
  assert.ok(
    Math.abs(
      combinedPrivateRuntimesCurrentMonthlyUsd
        - combinedPrivateRuntimesModel.combinedCurrentMonthlyUsd
    ) < 0.005
  );
  assert.ok(
    Math.abs(
      combinedPrivateRuntimesRotationMonthlyUsd
        - combinedPrivateRuntimesModel.combinedAfterTwoKmsRotationsMonthlyUsd
    ) < 0.005
  );
  assert.ok(
    combinedPrivateRuntimesRotationMonthlyUsd
      < combinedPrivateRuntimesModel.budgetMonthlyUsd
  );
  assert.equal(
    combinedPrivateRuntimesModel.items.find(
      (item) => item.id === "combined-interface-endpoints"
    )?.quantity,
    6 * 730
  );
  assert.equal(
    transitionalModel.items.find((item) => item.id === "worker-interface-endpoints")
      ?.quantity,
    5 * 730
  );
  console.log(
    `Cost gates checked: $${idle.totalMonthlyUsd.toFixed(2)} current / $${maxRotationMonthlyUsd.toFixed(2)} after two KMS rotations below the $${idleModel.idleTargetMonthlyUsd.toFixed(2)} default idle cap; the connector adds $${connector.totalMonthlyUsd.toFixed(2)}, the source archiver adds $${sourceArchiver.totalMonthlyUsd.toFixed(2)}, the isolated Observable coordinator adds $${coordinator.totalMonthlyUsd.toFixed(2)}, and combined worker/coordinator ownership adds $${combinedPrivateRuntimes.totalMonthlyUsd.toFixed(2)} fixed ($${combinedPrivateRuntimesRotationMonthlyUsd.toFixed(2)} with rotations), all under the $${coordinatorModel.budgetMonthlyUsd.toFixed(2)} circuit breaker; $${transitional.totalMonthlyUsd.toFixed(2)} remains rejected.`
  );
} else {
  console.table(
    idle.rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      monthlyUsd: `$${row.monthlyUsd.toFixed(2)}`
    }))
  );
  console.log(
    JSON.stringify(
      {
        asOf: idleModel.asOf,
        region: idleModel.region,
        foundationMonthlyUsd: Number(idle.foundationMonthlyUsd.toFixed(2)),
        apiMonthlyUsd: Number(idle.apiMonthlyUsd.toFixed(2)),
        totalMonthlyUsd: Number(idle.totalMonthlyUsd.toFixed(2)),
        maxRotationMonthlyUsd: Number(maxRotationMonthlyUsd.toFixed(2)),
        idleTargetMonthlyUsd: idleModel.idleTargetMonthlyUsd,
        satisfiesIdleTarget: idleModel.satisfiesIdleTarget,
        transitionalMonthlyUsd: Number(transitional.totalMonthlyUsd.toFixed(2)),
        budgetCircuitBreakerUsd: transitionalModel.budgetMonthlyUsd,
        connectorFixedMonthlyUsd: Number(connector.totalMonthlyUsd.toFixed(2)),
        connectorCombinedMonthlyUsd: Number(connectorCombinedMonthlyUsd.toFixed(2)),
        sourceArchiverFixedMonthlyUsd: Number(
          sourceArchiver.totalMonthlyUsd.toFixed(2)
        ),
        sourceArchiverCombinedMonthlyUsd: Number(
          sourceArchiverCombinedMonthlyUsd.toFixed(2)
        ),
        coordinatorFixedMonthlyUsd: Number(coordinator.totalMonthlyUsd.toFixed(2)),
        coordinatorCombinedMonthlyUsd: Number(coordinatorCombinedMonthlyUsd.toFixed(2)),
        combinedPrivateRuntimesFixedMonthlyUsd: Number(
          combinedPrivateRuntimes.totalMonthlyUsd.toFixed(2)
        ),
        combinedPrivateRuntimesCurrentMonthlyUsd: Number(
          combinedPrivateRuntimesCurrentMonthlyUsd.toFixed(2)
        ),
        combinedPrivateRuntimesRotationMonthlyUsd: Number(
          combinedPrivateRuntimesRotationMonthlyUsd.toFixed(2)
        )
      },
      null,
      2
    )
  );
}
