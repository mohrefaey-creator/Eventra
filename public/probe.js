// Loaded by /check. On a browser that cannot parse "?." and "??" this whole file is skipped, so the flag
// below never gets set, which is exactly what the check wants to find out.
window.__modernJs = (function () {
  var a = {};
  return (a?.b ?? 1) === 1;
})();
