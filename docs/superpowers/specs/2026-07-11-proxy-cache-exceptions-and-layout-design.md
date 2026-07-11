# Proxy Subscription Cache, Direct Exceptions, and Layout Design

## Goal

Make proxy subscriptions fully local after a successful update, let users add durable direct-routing exceptions, and align the Proxy page with the Service Manager visual hierarchy.

## Subscription Cache

After a subscription update succeeds, retain two local cache files in the proxy data directory:

- `subscription.yaml`: the fetched source payload for inspection and compatibility.
- `subscription.parsed.json`: the parsed `SubscriptionInfo` structure used by future starts and restarts.

Starting the proxy reads `subscription.parsed.json` and does not fetch or reparse the remote subscription. Updating the subscription is the only operation that downloads and replaces both cache files. For existing users who have only `subscription.yaml`, the first start parses it once, writes `subscription.parsed.json`, and then uses the parsed cache afterwards.

Only a successfully parsed update replaces the existing cache. A download, parse, or write failure leaves the previous working cache untouched.

## Direct Exceptions

`ProxySettings` gains a persisted `exceptions` list. Each exception has a stable ID, a rule type, and one value. The first release supports:

- exact domain (`DOMAIN`)
- domain suffix (`DOMAIN-SUFFIX`)
- domain keyword (`DOMAIN-KEYWORD`)
- IPv4 CIDR (`IP-CIDR`)
- IPv6 CIDR (`IP-CIDR6`)
- source IP CIDR (`SRC-IP-CIDR`)
- GeoIP country or region (`GEOIP`)
- destination port (`DST-PORT`)
- source port (`SRC-PORT`)

Every exception always targets `DIRECT`; the previously discussed “global direct” label has the same required target and therefore is not represented as a separate policy.

The runtime validates exception fields before persisting them. At config-build time, it converts valid exceptions to Clash/Mihomo rules and prepends them to the subscription’s own rules, ensuring they take priority. Subscription updates do not remove local exceptions. Invalid cached exceptions are omitted from the generated config and surfaced through the normal Proxy page error mechanism when a user tries to save them.

## IPC and Renderer

The main process exposes list, add/update, and delete exception operations. The renderer renders an `Exception Rules` section in the Proxy page with a type selector, value input, Add button, compact persisted rows, and per-row Edit/Delete controls. Dynamic exception values are always written through DOM text nodes.

Strategy-group selections remain stored in `selectedProxies`; exceptions share the same settings file and are restored without extra user actions when the application reopens.

## Layout

The Proxy page wraps its runtime controls, subscription controls, strategy groups, and exception rules in one white bordered content container matching the host-page visual treatment. The left navigation keeps the app icon. The duplicate page-header fox image on the Host page is removed.

## Tests and Documentation

Add pure tests for parsed-cache preference and legacy raw-cache migration, exception validation, conversion, and precedence over subscription rules. Add renderer layout tests for the white Proxy container, exception section, and removed Host-page logo. Update `README.md` and `AGENTS.md` for cache files, the exception schema, rule precedence, and UI behavior.
