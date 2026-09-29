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
