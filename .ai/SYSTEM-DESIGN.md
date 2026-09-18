# System design

How the pieces fit for the current task. Stable architecture lives in
`ARCHITECTURE.md`; this file is the design of the change.

_No active design._

## Components touched

## Data flow

## API contracts

_Method, path, auth, request, response, error codes. A contract change is a
breaking change until proven otherwise._

## Database

_Tables, columns, indexes, constraints. Migrations are forward-only; there are
no down migrations._

## Queue and worker design

## Failure modes

_What breaks, what the user sees, how the system recovers. A design without
this section is incomplete, not concise._

## Scaling

_Current deployment is a single 2 vCPU host. Say what that means for this
design rather than assuming horizontal scale._

## Security boundaries

## Observability

## Trade-offs

_What was given up, and why it was the right call._
