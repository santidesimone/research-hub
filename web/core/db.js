const neo4j = require('neo4j-driver');
const config = require('./config');

const { uri, user, password, poolSize } = config.get().neo4j;
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  maxConnectionPoolSize: poolSize,
  connectionAcquisitionTimeout: 30000, // fail with a clear error instead of queueing forever when the pool is exhausted
  maxTransactionRetryTime: 10000,
});

function plain(v) {
  if (neo4j.isInt(v)) return v.toNumber();
  if (neo4j.isDateTime(v) || neo4j.isDate(v)) return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

async function run(query, params = {}) { // read-only
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    return (await session.run(query, params)).records.map((r) => plain(r.toObject()));
  } finally {
    await session.close();
  }
}

async function writeTx(fn) { // fn(tx) runs in one transaction
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    return await session.executeWrite(fn);
  } finally {
    await session.close();
  }
}

async function exec(query, params = {}) { // single auto-commit write (needed for schema/DDL statements)
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    return (await session.run(query, params)).records.map((r) => plain(r.toObject()));
  } finally {
    await session.close();
  }
}

module.exports = { run, writeTx, exec, driver, plain };
