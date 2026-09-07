// @animastor/contracts — public entry point.
// Currently the only published contract is Job Protocol v2
// (docs/architecture/JOB_PROTOCOL_V2.md — NORMATIVE, FROZEN).
module.exports = {
    jobProtocolV2: require('./job-protocol-v2'),
    ...require('./job-protocol-v2'),
};
