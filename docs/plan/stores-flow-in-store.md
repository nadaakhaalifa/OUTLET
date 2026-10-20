# Stores flow: in-store option (decision note)

Status: Proposed, owner to decide.

Flow: /stores (online or in-store) -> /stores/scope (Local, Global, Both) -> /stores/list?scope= -> /shop-all?store=<id>.

In-store: the data model has no physical outlet data (no addresses, hours, distance). The option is shown but leads to an honest empty state, "In-store visits are not available yet", with one action back to the scope step. Nothing is invented.

Owner decision needed: hide the in-store card until outlet data exists, or keep it as a visible placeholder (current). Real outlets need a store-location entity, PDPL review for any location features, and seller-supplied hours.

Also: the chosen scope is passed as a route param and is not persisted to the shared worlds preference, so Home and Explore are unaffected. Persisting is a one-line change via useWorld if wanted.

## Update: naming and split (online vs outlets)

Decision: the In-store card is named "Outlets" (AR: "المنافذ"), sublabel "Visit an outlet shop near you", button "Find outlets", list header "Outlet shops" (AR: "منافذ البيع"). "Stores" was rejected because every online shop is also a store; "In-store" reads as a mode, not a place.

- /stores/list?scope=local|global|both: ONLINE shops only (name, local/global tag, delivery days, verified discount, rating when present). No hours or distance.
- /stores/outlets: PHYSICAL outlets with city, Open and closing time, distance, rendered only when those fields exist. Dev fixtures supply three board outlets; production has no outlet data and shows "Outlet shops are not available yet".
- /stores/in-store redirects to /stores/outlets.
