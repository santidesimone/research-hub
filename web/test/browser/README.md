# Browser checks (Library UI)

Playwright scripts that drive a real Chrome against a running hub: the owner's flows (sign-in, collections, the paper Analysis tab, create / edit / link / delete, structured editors, the audit, the graph), an anonymous visitor (public whitelist only), and a 390px mobile viewport. They fail on any console error, CSP violation or failed request.

They are not part of `npm test` and not a project dependency. CI runs them in the `e2e` job (`.github/workflows/ci.yml`), followed by `web/test/cli-e2e.js` (the real CLI against the same hub). To run them:

```bash
# 1. a THROWAWAY Neo4j and a hub on it (the seed writes data)
docker run -d --rm --name hub-browser-neo4j -p 17687:7687 -e NEO4J_AUTH=neo4j/throwaway123 neo4j:5-community
(cd web && NEO4J_URI=bolt://127.0.0.1:17687 NEO4J_PASSWORD=throwaway123 HUB_API_TOKEN=$(openssl rand -hex 32 | tee /tmp/tok) PORT=18082 node server.js &)
# 2. playwright-core outside the repo (it drives your installed Chrome; CHROME_PATH if it is not in the default macOS place)
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright-core@1.47.2)
# 3. data, then the checks (each seed is single use: run it on a fresh database)
export HUB_URL=http://127.0.0.1:18082 HUB_API_TOKEN=$(cat /tmp/tok) NODE_PATH=/tmp/pw/node_modules
node web/test/browser/seed.js && node web/test/browser/owner.js && node web/test/browser/public-mobile.js
```

Screenshots go to `$OUT` (default: the system temp folder).
