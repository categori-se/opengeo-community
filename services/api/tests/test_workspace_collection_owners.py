"""Typed owner requests and bounded repository effects; SQL acceptance is separate."""

import asyncio
from uuid import UUID

import pytest
from pydantic import ValidationError

from opengeo_api.collection_routes import CollectionCreate, CollectionOwnerUpdate
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspace_collections import (
    CollectionAccessDenied,
    CollectionConflict,
    PostgresCollectionRepository,
)
from test_workspaces import FakeExecutor, FakeTransaction

ACCOUNT = UUID("10000000-0000-4000-8000-000000000001")
USER = UUID("20000000-0000-4000-8000-000000000001")
OTHER_USER = UUID("20000000-0000-4000-8000-000000000002")
TEAM = UUID("90000000-0000-4000-8000-000000000001")
COLLECTION = UUID("a0000000-0000-4000-8000-000000000001")
CONTEXT = TenantContext(USER, ACCOUNT)


def principal(kind="team", identity=TEAM):
    return {"principal_type": kind, "principal_id": identity}


def role_row(role="owner", kind="user", identity=USER):
    return (
        "Survey",
        "",
        identity if kind == "user" else None,
        USER,
        3,
        role,
        "private",
        kind,
        identity,
        "Field team" if kind == "team" else "Owner",
    )


def setup(one, all_rows=None):
    tx = FakeTransaction(one=one, all_rows=all_rows)
    return PostgresCollectionRepository(FakeExecutor(tx)), tx


def writes(tx):
    return [call for call in tx.calls if call[0] == "execute"]


def test_default_create_preserves_user_owner_creator_and_audits_actual_owner():
    repository, tx = setup([("member",)])
    receipt = asyncio.run(repository.create(CONTEXT, " Survey ", request_id="create-1"))
    insert, event = writes(tx)
    assert insert[2][2:] == ("Survey", "", USER, None, None, USER)
    assert receipt["revision"] == 1
    assert "FOR SHARE" in tx.calls[0][1]
    assert event[2][2:5] == ("collection.created", UUID(receipt["id"]), "create-1")
    assert event[2][5].obj == {
        "previous_owner": None,
        "owner": {"principal_type": "user", "principal_id": str(USER)},
    }


def test_team_manager_create_keeps_actual_team_owner_and_separate_creator():
    repository, tx = setup([("member",), (TEAM,), ("manager",)])
    asyncio.run(repository.create(CONTEXT, "Survey", owner=principal()))
    assert writes(tx)[0][2][4:] == (None, TEAM, None, USER)
    assert "status='active' FOR SHARE" in tx.calls[1][1]
    assert "FOR SHARE" in tx.calls[2][1]


@pytest.mark.parametrize("member", [None, ("member",)])
def test_team_member_or_nonmember_cannot_create_team_owned_collection(member):
    repository, tx = setup([("member",), (TEAM,), member])
    with pytest.raises(CollectionAccessDenied):
        asyncio.run(repository.create(CONTEXT, "Survey", owner=principal()))
    assert writes(tx) == []


def test_organization_owner_requires_current_admin_and_owning_account():
    repository, tx = setup([("member",)])
    with pytest.raises(CollectionAccessDenied):
        asyncio.run(repository.create(CONTEXT, "Survey", owner=principal("organization", ACCOUNT)))
    assert writes(tx) == []
    repository, tx = setup([("admin",), (ACCOUNT,)])
    asyncio.run(repository.create(CONTEXT, "Survey", owner=principal("organization", ACCOUNT)))
    assert writes(tx)[0][2][4:] == (None, None, ACCOUNT, USER)


def test_default_user_create_cannot_assign_someone_else_without_admin():
    repository, tx = setup([("member",)])
    with pytest.raises(CollectionAccessDenied):
        asyncio.run(repository.create(CONTEXT, "Survey", owner=principal("user", OTHER_USER)))
    assert writes(tx) == []


def test_transfer_to_current_user_preserves_creator_and_audits_previous_owner():
    repository, tx = setup(
        [
            ("member",),
            (None,),
            role_row(),
            ("member",),
            (OTHER_USER,),
        ]
    )
    result = asyncio.run(
        repository.set_owner(
            CONTEXT,
            COLLECTION,
            3,
            principal("user", OTHER_USER),
            "transfer-1",
        )
    )
    update, event = writes(tx)
    assert result == {"id": str(COLLECTION), "revision": 4}
    assert update[2] == (OTHER_USER, None, None, ACCOUNT, COLLECTION)
    assert "created_by" not in update[1]
    assert event[2][2] == "collection.owner.changed"
    assert event[2][-1].obj == {
        "previous_owner": {"principal_type": "user", "principal_id": str(USER)},
        "owner": {"principal_type": "user", "principal_id": str(OTHER_USER)},
    }


@pytest.mark.parametrize("role", ["reader", "editor"])
def test_reader_and_editor_cannot_change_owner(role):
    repository, tx = setup([("member",), (None,), role_row(role=role)])
    with pytest.raises(CollectionAccessDenied):
        asyncio.run(repository.set_owner(CONTEXT, COLLECTION, 3, principal()))
    assert writes(tx) == []


def test_stale_transfer_does_not_validate_target_or_write():
    repository, tx = setup([("member",), (None,), role_row()])
    with pytest.raises(CollectionConflict, match="revision"):
        asyncio.run(repository.set_owner(CONTEXT, COLLECTION, 2, principal()))
    assert len(tx.calls) == 3 and writes(tx) == []


def test_unavailable_target_does_not_replace_current_owner():
    repository, tx = setup(
        [
            ("member",),
            (None,),
            role_row(),
            ("member",),
            None,
        ]
    )
    with pytest.raises(CollectionConflict, match="owner_unavailable"):
        asyncio.run(repository.set_owner(CONTEXT, COLLECTION, 3, principal("user", OTHER_USER)))
    assert writes(tx) == []


def test_same_owner_transfer_rechecks_target_and_retains_revision():
    repository, tx = setup(
        [
            ("member",),
            (None,),
            role_row(),
            ("member",),
            (USER,),
        ]
    )
    result = asyncio.run(repository.set_owner(CONTEXT, COLLECTION, 3, principal("user", USER)))
    assert result["revision"] == 3 and writes(tx) == []
    assert "FOR SHARE" in tx.calls[-1][1]


def test_team_owner_write_pins_team_and_current_org_membership():
    repository, tx = setup(
        [
            ("member",),
            (TEAM,),
            (TEAM,),
            role_row(kind="team", identity=TEAM),
            ("member",),
            (OTHER_USER,),
        ]
    )
    asyncio.run(repository.set_owner(CONTEXT, COLLECTION, 3, principal("user", OTHER_USER)))
    assert "FOR UPDATE" in tx.calls[1][1]
    assert "FOR SHARE" in tx.calls[2][1]
    authority = tx.calls[3][1]
    assert "team.status='active'" in authority
    assert "tm.role::text IN ('owner','manager')" in authority
    assert "tm.role::text='member'" in authority
    assert "JOIN app.organization_memberships" in authority


def test_nonuser_read_keeps_typed_owner_and_does_not_fall_back_to_creator():
    saved = role_row(kind="team", identity=TEAM)
    repository, _tx = setup([saved, saved], [[]])
    record = asyncio.run(repository.read(CONTEXT, COLLECTION))
    assert record["owner"] == {"principal_type": "team", "principal_id": str(TEAM)}
    assert record["owner_user_id"] is None
    assert record["created_by"] == str(USER)
    assert record["owner_name"] == "Field team"


def test_create_and_transfer_candidate_pagination_have_distinct_user_scope():
    repository, tx = setup([("member",), ("member",)], [[(USER, "Owner")]])
    candidates = asyncio.run(repository.owner_candidates(CONTEXT, "user", 2, 4))
    assert candidates == [{"principal_type": "user", "principal_id": str(USER), "name": "Owner"}]
    assert next(call for call in tx.calls if call[0] == "all")[2] == (ACCOUNT, False, USER, 2, 4)
    repository, tx = setup([("member",), role_row(), role_row()], [[(OTHER_USER, "Recipient")]])
    asyncio.run(repository.owner_candidates(CONTEXT, "user", collection_id=COLLECTION))
    assert next(call for call in tx.calls if call[0] == "all")[2][1] is True


def test_transfer_candidates_require_current_owner():
    repository, tx = setup([("member",), role_row(role="editor")])
    with pytest.raises(CollectionAccessDenied):
        asyncio.run(repository.owner_candidates(CONTEXT, "user", collection_id=COLLECTION))
    assert not any(call[0] == "all" for call in tx.calls)


def test_team_member_removal_during_target_resolution_discards_original_private_body():
    async def journey():
        saved = role_row(kind="team", identity=TEAM)
        repository, tx = setup(
            [saved, role_row(role="reader", kind="team", identity=TEAM)],
            [
                [(COLLECTION, OTHER_USER, None)],
            ],
        )
        reached = asyncio.Event()
        resume = asyncio.Event()

        async def held_target(*args):
            del args
            reached.set()
            await resume.wait()
            return None

        repository._target = held_target
        pending = asyncio.create_task(repository.read(CONTEXT, COLLECTION))
        await reached.wait()
        assert not pending.done()
        resume.set()
        with pytest.raises(CollectionConflict, match="authority_changed"):
            await pending
        assert writes(tx) == []

    asyncio.run(journey())


def test_new_owner_request_contract_rejects_bool_revision_unknown_kind_and_extra_fields():
    assert CollectionCreate(title="Survey").owner is None
    for payload in [
        {"expected_revision": True, "owner": principal()},
        {"expected_revision": 1, "owner": principal("agency", ACCOUNT)},
        {"expected_revision": 1, "owner": {**principal(), "created_by": USER}},
    ]:
        with pytest.raises(ValidationError):
            CollectionOwnerUpdate.model_validate(payload)
