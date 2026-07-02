/**
 * IIFE bundle entry. A `<script src="couch-sdk.iife.js">` tag should expose the
 * SDK object DIRECTLY as the global `CouchSDK`, so creators can call
 * `CouchSDK.init(...)` without any nesting. This entry has a single default
 * export (built with rollup `output.exports: 'default'`), which makes Vite emit
 * `var CouchSDK = <the object>` rather than a module namespace.
 *
 * The ESM entry (`index.ts`) keeps named exports so the host app can
 * `import type { ... }` the protocol types.
 */
import { CouchSDK } from './index';

export default CouchSDK;
