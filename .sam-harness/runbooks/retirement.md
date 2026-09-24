# Migration and retirement

1. Inventory producers, consumers, stored data, credentials, schedules, and rollback dependencies.
2. Introduce versioned compatibility before cutover and keep migration commands resumable and idempotent.
3. Reconcile records and invariants, verify deletion propagation and restore, then collect explicit owner acceptance.
4. Remove the old path only after the observation window and rollback boundary close. Revoke credentials and archive evidence according to policy.

No executable migration, rollback, or release schedule is configured. Retirement is not approved.
