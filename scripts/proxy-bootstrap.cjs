const https = require("node:https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (proxyUrl) {
  const proxyAgent = new HttpsProxyAgent(proxyUrl);
  const originalRequest = https.request;

  https.globalAgent = proxyAgent;
  https.request = function requestThroughProxy(options, ...args) {
    if (options && typeof options === "object" && !(options instanceof URL)) {
      options.agent ??= proxyAgent;
    }

    return originalRequest.call(this, options, ...args);
  };
}
