const { inspectLaunchReadiness } = require("./launch-readiness");

const result = inspectLaunchReadiness(process.env);
console.log(result.ready ? "ListingFlow готов к коммерческому запуску." : "ListingFlow пока не готов к коммерческому запуску.");
for (const item of result.blockers) console.log(`BLOCKER: ${item}`);
for (const item of result.warnings) console.log(`WARNING: ${item}`);
if (result.callbackUrl) console.log(`Platega callback: ${result.callbackUrl}`);
if (result.healthUrl) console.log(`Health check: ${result.healthUrl}`);
if (!result.ready) process.exitCode = 1;
