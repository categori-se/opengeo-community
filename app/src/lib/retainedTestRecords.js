// Retained application-verification records, confirmed by the owner's inventory.
// Do not classify a user's project merely because its title includes "test".
const accessContainers = new Set([
  "ac497a0a-71ae-47a7-8150-9a333883b16d",
  "b4e31918-d219-424d-9ac4-d32c7fc2c6b6",
  "177f4c87-6975-4262-9327-39e25fa9a6cf",
  "b4ea86fa-81f5-5e30-b4de-434300668943",
  "e89752d9-dcbd-56a7-b1ea-7ee222d19569",
  "f4502580-5ab3-5b9d-99cc-2b69f3e7eabb",
  "aa2514be-31ed-5adc-a3bf-0a7845b843d1",
  "1e643be8-77c5-5fa1-a04d-ef3650ee792d"
]);
const compositions = new Set([
  "5a86c685-51a1-4822-b9a6-2476bf171435",
  "7b0ac88c-53f7-4fd4-bde2-cd9229df0411",
  "696ac547-47c9-4998-8610-a363bdc47d62",
  "ae6bc0fd-34ed-4a64-a9e6-80b6ef24ea09",
  "072937ff-eb02-44b0-a652-caa5da948067"
]);
export function isRetainedTestRecord(record) {
  return accessContainers.has(record.projectId ?? record.accessContainerId ?? record.id)
    || compositions.has(record.id);
}
