# Boundary decisions

1. Single generic Supervisor core.
2. Executor boundary is separate from Supervisor core.
3. Project adapter boundary holds project-specific wiring and policies.
4. Diff and admissibility belong to Supervisor.
5. OpenHands is an executor integration target only.
6. Argus Core will be absorbed into the single Supervisor core.
7. StateStore and MergeWatcher are deferred.
8. Supervisor must not depend on BomPraTi.
