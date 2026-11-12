// Public preview only: synthetic model responses, synthetic accounts, and no
// real provider, bank credential, payment, or trading connection.
import production from './worker.mjs';
import {CanarySession, CanaryGate} from './canary.mjs';
import risk from './risk.mjs';

export {CanarySession, CanaryGate};

export default {
  async fetch(request, env) {
    const scoped = {
      ...env,
      AMOUNT_RISK: {fetch: riskRequest => risk.fetch(riskRequest, {RISK_HMAC_SECRET: env.RISK_HMAC_SECRET})},
    };
    return production.fetch(request, scoped);
  },
};
