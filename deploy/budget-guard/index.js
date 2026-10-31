// Budget guard: a soft stop when the month's cost reaches the budget. Budgets only alert, so this Cloud Run function
// listens to the budget's Pub/Sub topic and, once costAmount >= budgetAmount, stops the Neo4j VM and closes the app
// to public traffic. Nothing is deleted (the disk and snapshots stay), so resuming is two commands (deploy/README.md).
// Billing data reaches the budget hours late: this bounds spending, it is not an instant cap.
// No dependencies: the function runs as the project's default compute service account and gets its token from the
// metadata server. Configured by PROJECT, ZONE, VM, REGION, SERVICE (set by deploy/budget-guard.sh).

const META = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

// The budget notification, from a Pub/Sub CloudEvent. -> { cost, budget } or null if it is not one
function parse(cloudEvent) {
  try {
    const data = JSON.parse(Buffer.from(cloudEvent.data.message.data, 'base64').toString());
    if (typeof data.costAmount !== 'number' || typeof data.budgetAmount !== 'number') return null;
    return { cost: data.costAmount, budget: data.budgetAmount };
  } catch { return null; }
}

const overBudget = (n) => Boolean(n && n.budget > 0 && n.cost >= n.budget);

async function stopAll(env, http = fetch) {
  const tok = (await (await http(META, { headers: { 'Metadata-Flavor': 'Google' } })).json()).access_token;
  const auth = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const done = [];
  const vm = await http(`https://compute.googleapis.com/compute/v1/projects/${env.PROJECT}/zones/${env.ZONE}/instances/${env.VM}/stop`, { method: 'POST', headers: auth });
  done.push(`stop VM ${env.VM}: ${vm.status}`);
  const run = await http(`https://run.googleapis.com/v2/projects/${env.PROJECT}/locations/${env.REGION}/services/${env.SERVICE}?updateMask=ingress`,
    { method: 'PATCH', headers: auth, body: JSON.stringify({ ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' }) });
  done.push(`close ${env.SERVICE} to public traffic: ${run.status}`);
  if (!vm.ok || !run.ok) throw new Error('budget guard: ' + done.join('; '));
  return done;
}

async function guard(cloudEvent, { env = process.env, http = fetch, log = console.log } = {}) {
  const n = parse(cloudEvent);
  if (!overBudget(n)) { log(`budget guard: ${n ? `${n.cost} of ${n.budget}` : 'not a budget notification'}, nothing to do`); return []; }
  log(`budget guard: cost ${n.cost} reached the budget ${n.budget}; stopping`);
  const done = await stopAll(env, http);
  log('budget guard: ' + done.join('; '));
  return done;
}

module.exports = { guard, parse, overBudget, stopAll };
