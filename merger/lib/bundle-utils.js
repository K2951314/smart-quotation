(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./data-utils"));
  } else {
    root.BundleUtils = factory(root.DataUtils);
  }
})(typeof self !== "undefined" ? self : this, function (DataUtils) {
  if (!DataUtils) throw new Error("DataUtils is required");

  function getCryptoApi() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    if (typeof require === "function") {
      try {
        var nodeCrypto = require("crypto").webcrypto;
        if (nodeCrypto && nodeCrypto.subtle) return nodeCrypto;
      } catch (e) {
      }
    }
    throw new Error("WebCrypto API is not available");
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(bytes);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("utf8");
    }
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }

  function base64ToBytes(base64) {
    if (typeof atob === "function") {
      var raw = atob(base64);
      var out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(base64, "base64"));
    }
    throw new Error("Base64 decoder is not available");
  }

  async function encryptText(plainText, password) {
    var cryptoApi = getCryptoApi();
    var enc = new TextEncoder();

    var keyMaterial = await cryptoApi.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    var salt = cryptoApi.getRandomValues(new Uint8Array(16));
    var key = await cryptoApi.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );

    var iv = cryptoApi.getRandomValues(new Uint8Array(12));
    var encrypted = await cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      key,
      enc.encode(plainText)
    );

    var cipher = new Uint8Array(encrypted);
    var bundle = new Uint8Array(salt.length + iv.length + cipher.length);
    bundle.set(salt, 0);
    bundle.set(iv, salt.length);
    bundle.set(cipher, salt.length + iv.length);

    return DataUtils.bytesToBase64(bundle);
  }

  async function decryptText(payloadBase64, password) {
    var cryptoApi = getCryptoApi();
    var enc = new TextEncoder();
    var data = base64ToBytes(payloadBase64);
    var salt = data.slice(0, 16);
    var iv = data.slice(16, 28);
    var cipher = data.slice(28);

    var keyMaterial = await cryptoApi.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    var key = await cryptoApi.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    var plainBuffer = await cryptoApi.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      key,
      cipher
    );

    return bytesToUtf8(new Uint8Array(plainBuffer));
  }

  function decodePlainPayload(payloadBase64) {
    return bytesToUtf8(base64ToBytes(payloadBase64));
  }

  function toWindowScript(varName, obj) {
    return "window." + varName + " = " + JSON.stringify(obj) + ";";
  }

  async function encodePriceBundle(priceDataset, password) {
    var bySpec = (priceDataset && priceDataset.bySpec) || {};
    var json = JSON.stringify({ bySpec: bySpec });
    var secured = !!(password && String(password).trim());
    var payload = secured
      ? await encryptText(json, String(password).trim())
      : DataUtils.utf8ToBase64(json);

    return {
      secured: secured,
      payload: payload,
      meta: {
        version: new Date().toISOString(),
        rowCount: Object.keys(bySpec).length,
      },
    };
  }

  async function decodePriceBundle(bundle, password) {
    var data = bundle || {};
    var text;
    if (data.secured) {
      if (!password) throw new Error("Price bundle password is required");
      text = await decryptText(data.payload, password);
    } else {
      text = decodePlainPayload(data.payload || "");
    }
    var parsed = JSON.parse(text || "{}");
    return { bySpec: parsed.bySpec || {} };
  }

  function encodeStockBundle(stockByCode) {
    var byCode = stockByCode || {};
    var json = JSON.stringify({ byCode: byCode });
    return {
      secured: false,
      payload: DataUtils.utf8ToBase64(json),
      meta: {
        version: new Date().toISOString(),
        rowCount: Object.keys(byCode).length,
      },
    };
  }

  function decodeStockBundle(bundle) {
    var data = bundle || {};
    if (data.secured) throw new Error("Stock bundle should remain plain in this architecture");
    var text = decodePlainPayload(data.payload || "");
    var parsed = JSON.parse(text || "{}");
    return { byCode: parsed.byCode || {} };
  }

  return {
    encodePriceBundle: encodePriceBundle,
    decodePriceBundle: decodePriceBundle,
    encodeStockBundle: encodeStockBundle,
    decodeStockBundle: decodeStockBundle,
    encryptText: encryptText,
    decryptText: decryptText,
    toWindowScript: toWindowScript,
  };
});
