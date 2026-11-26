# Database

The proxy keeps little in MongoDB. The marketplace entities (offerings, specifications, parties, inventory, orders, bills) live in the TMForum APIs, and the proxy reads and writes them over HTTP. Files live in the file service and the search index in the search service. What is in MongoDB is what the proxy itself needs: the carts, the blog, the feedback, the identity providers an administrator adds, the settings an administrator changes from the portal, the figures of the landing page, a few records about the platform, and, when you choose it, the authentication store.

## Connection

The server connects in the background after it starts and keeps trying, with a growing delay between attempts, until MongoDB answers. Each attempt is logged with the address (never the credentials). `GET /health/ready` answers 503 while MongoDB does not reply, and `GET /health/live` does not look at it.

The address is `mongo.uri` or the parts `mongo.host`, `mongo.port`, `mongo.database`, `mongo.user`, `mongo.password` and `mongo.authSource`. [kubernetes.md](kubernetes.md#keys) lists the keys and their environment variables.

Once the connection is up, the proxy creates the indexes of the collections below. It only creates them: an index that already exists with another definition, or that the data in the collection breaks (a duplicate in a unique index), is logged as an error and left as it is.

## Collections

| Collection | What it holds | Written when |
|---|---|---|
| `auth_cache` | Sessions, profiles of logged-in users and logins in progress | A user logs in, and with each request that refreshes it. Only with `auth.store.type: mongo` |
| `config` | The settings that an administrator changes from the portal | An administrator saves them |
| `blogs` | The entries of the blog, the news and the questions | An administrator writes them |
| `cartitems` | The items of each user's shopping cart | A user adds or removes an item |
| `feedback` | The ratings that users send from the portal | A user sends one |
| `idps` | The identity providers added with `/IDP` | An administrator adds, changes or removes one. Only with `auth.externalLogin.enabled` |
| `stats` | The figures of the landing page | The first request after they expire |
| `defaultcatalog`, `systemcategory`, `supportpackagespec` | The ids that the platform created in TMForum | The server starts |

A collection appears when something is first written to it.

### auth_cache

It holds what the authentication has to remember between requests and between instances. Each document has an `_id`, a `value` and an `expiresAt`:

- The `_id` is a hash of the key the proxy asked for, so a token or a session id is never written as an id.
- The `value` is sealed with AES-256-GCM using `auth.store.encryptionKey`, and starts with `v1.`, which names the format. Nothing in it can be read without the key.
- `expiresAt` has a TTL index. MongoDB removes the document within about a minute of that date, and a read also checks the date, so an expired entry is never used.

The keys the proxy builds, before they are hashed:

| Key | Holds | Lives |
|---|---|---|
| `profile:<access token>` | The profile of the user who owns the token, with their tokens, roles and organizations | `auth.profileTtlMs` (2 hours), or the life of the token when there is no refresh token. A token that was replaced by a refresh keeps answering for `auth.replacedTokenGraceMs` (30 seconds) |
| `session:<id>` | The session of the browser: the token it logged in with and the logins still pending | `auth.session.maxAgeMs` (24 hours), renewed on use. A login that is pending lasts 10 minutes |
| `vc:code:<state>` | The code of a login with credentials that is waiting for the browser to ask for it | 5 minutes |
| `vc:cert:<state>` | The credential of a certification that is waiting to be picked up | 100 seconds |

With the default store (`auth.store.type: memory`) none of this is in MongoDB. It then lives in the memory of each instance, is lost on restart, and is not shared, so several instances need `mongo`.

It is safe to empty the collection. Users log in again.

### config

Each document has an `id` and is created by the first save. They are read by the instances, so a change reaches all of them: the feature switches are read again every 5 seconds.

| `id` | Shape | Set from |
|---|---|---|
| `feature-flags` | `{ features: { purchaseEnabled: true, ... } }` | `PATCH /config/features` |
| `search-filters` | `{ searchFilters: [...] }` | `PATCH /config/filters` |
| `search` | `{ search: { searchUrl, useQueryKeyword } }` | `PATCH /config/search` |
| `analytics` | `{ analytics: { ... } }` | `PATCH /config/analytics` |

A value stored here wins over the one in the configuration file, but only for what an administrator can change from the portal. The rest of the configuration is read once, when the server starts.

### blogs

One document per entry: `title`, `content`, `contentType` (`blog`, `news` or `faq`), `slug`, `featuredImage`, `metaDescription`, `excerpt`, `author`, `partyId`, `tags` and `date`. `slugNormalized` is the slug in lower case. The proxy uses it for the unique index and does not give it back to clients.

Entries from version 11 that have no slug get one in the background when the server starts, built from the title. Entries older than `contentType` have it as `type`.

### cartitems

One document per item: `user`, `itemId` and `itemObject`, the item as the portal sent it. A user may have at most `limits.cartItems` items (100 by default).

### feedback

One document per rating: `id`, `rating` (a whole number from 1 to 5), `description`, `type` and `creation_date`.

### idps

One document per identity provider: `provider`, `name`, `server`, `clientID`, `callbackURL`, `idpId`, `issuerDid`, `description`, `tokenKey` and `tokenCrt`. They are all i4Trust providers. When the server starts it registers the ones stored here, so they are available for login from the beginning.

### stats

A single document with `_id: stats`, the lists `services` and `organizations` (names), and `computedAt`. When it is older than `stats.ttlMs` (24 hours), the next request recalculates it, and if that fails it tries again after `stats.retryDelayMs` (10 minutes). Nothing runs on a schedule. A document from version 11 has no date, so it counts as expired and the first refresh writes the new one.

It is safe to delete it. The next request makes it again.

### defaultcatalog, systemcategory and supportpackagespec

The proxy makes sure, every time it starts, that the default catalog, the system categories (`dataset`, `api` and `blueprint` by default) and the support package specification exist in TMForum. These collections remember the ids it found or created, so it uses the same ones next time:

| Collection | Document |
|---|---|
| `defaultcatalog` | `{ id: "default", default_id: <id of the catalog in TMForum> }` |
| `systemcategory` | One per category: `{ id: <key>, category_id: <id of the category in TMForum> }` |
| `supportpackagespec` | `{ id: "global", spec_id: <id of the specification in TMForum> }` |

Each has a unique index on `id`. Do not delete them by hand: without them the proxy looks again by name, and what it cannot match it creates anew.

## Indexes

| Collection | Index | Purpose |
|---|---|---|
| `auth_cache` | TTL on `expiresAt` | Removes expired entries |
| `config` | Unique on `id`, only for the documents that have one | One document per setting, even when two instances save it for the first time at once. A document without `id` is left out |
| `blogs` | Unique on `slugNormalized`, only when the slug exists | One slug per entry, whatever its case |
| `cartitems` | Unique on `user` and `itemId` | One line per item in a cart |
| `idps` | Unique on `idpId`, and text on `name` | One provider per id, and search by name. MongoDB allows one text index per collection, so a search does not look at `description` |
| `defaultcatalog`, `systemcategory`, `supportpackagespec` | Unique on `id` | One record per id |

## Upgrading from version 11

Version 12 reads the collections of version 11 as they are: `blogs`, `cartitems`, `feedback`, `idps` and `stats` keep their names, fields and indexes. Nothing has to be migrated.

Version 12 does not use these collections of version 11. They can stay or be dropped: `accesstokenservices`, `accountingservices`, `promotions`, `recommendations`, `reputationmodels`, `slamodels` and `tokenservices`.

## What to back up

Everything except `auth_cache` and `stats`, which the proxy rebuilds. The entities of the marketplace are not here: they are backed up with the storage of the TMForum APIs.
