# TikTok Shop Order Synchronization

This context keeps TikTok Shop order-related data synchronized through an authenticated Seller Center session and delivers captured data to the ERP.

## Language

**Order Domain**:
An independently progressing family of order data: Orders, Logistics, Order Details, Order History, or Statements.
_Avoid_: Job type, task kind

**Sync Run**:
One attempt to advance an Order Domain from its durable progress for the currently bound shop.
_Avoid_: Poll, batch job

**Seller Center Binding**:
The association between one TikTok Shop identity and the authenticated Seller Center tab used for that shop.
_Avoid_: Active tab, current page

**Bound Page Request**:
A TikTok request executed with the authenticated session provided by the Seller Center Binding.
_Avoid_: Injected fetch, proxied call

**Continuation**:
A scheduled follow-up that resumes an unfinished Order Domain from durable progress.
_Avoid_: Retry, next poll

## Business Invariants

**Persistence boundary**:
Every datum produced by a synchronization plugin is first persisted by TTS ERP under the PostgreSQL `plugin` schema. The plugin must not write canonical business schemas directly; any later promotion or normalization is a server-side concern.

**T-1 cutoff**:
Every automatic or user-triggered Sync Run may synchronize only records strictly before the current shop-local calendar day. One logical automatic run is scheduled per shop-local day; the Popup may request an additional manual run with the same cutoff.

**Refund semantics**:
A refund record does not by itself prove that the entire order was refunded. Use the structured refund amount whenever the Shop response provides one. When no amount is provided, preserve the amount as unknown until an explicit fallback rule is agreed. Refund status and return-logistics state remain separate facts and must also be synchronized when available.
