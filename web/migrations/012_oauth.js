// OAuth connections for the MCP connector (Task 9, core/oauth.js): one (:OAuthGrant) per connected client, holding only a
// hash of its refresh token, and short-lived single-use (:OAuthCode) nodes. Neither is part of the library: backup, the
// public export and the collections never include them. Idempotent.
module.exports = {
  id: '012_oauth',
  description: 'OAuth connections for MCP clients: unique grant ids and code hashes',
  async up(db) {
    await db.run('CREATE CONSTRAINT oauth_grant_id IF NOT EXISTS FOR (g:OAuthGrant) REQUIRE g.id IS UNIQUE');
    await db.run('CREATE CONSTRAINT oauth_code_hash IF NOT EXISTS FOR (c:OAuthCode) REQUIRE c.hash IS UNIQUE');
  },
};
