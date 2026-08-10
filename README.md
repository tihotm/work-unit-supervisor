# Work Unit Supervisor

Status: bootstrap / extraction in progress

Purpose:

Generic project-independent supervisor for controlled WorkUnit execution.

Boundary:

Supervisor
- decision
- orchestration/control
- policies
- admissibility
- audit

Executors
- concrete execution backends

Project adapters
- project-specific policies and wiring

Dependency rule:

Consumer projects depend on Supervisor.
Supervisor never depends on consumer projects.

Non-goals in this stage:

- automotive/catalog domain
- BomPraTi-specific behavior
- agent framework
- durable workflow engine
- UI/control center

Argus Core will be merged into the single Supervisor core; it will not exist as an independent second core.
