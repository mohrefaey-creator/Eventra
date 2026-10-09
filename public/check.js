// Deliberately written in the oldest JavaScript there is, so that it still runs on browsers too old for the receiver.
(function () {
  var rows = document.getElementById('rows');
  var needed = 0, missing = 0;

  function row(name, ok, detail, required) {
    if (required) { needed++; if (!ok) missing++; }
    var tr = document.createElement('tr');
    var a = document.createElement('td'); a.className = 'name'; a.textContent = name;
    var b = document.createElement('td');
    var mark = document.createElement('span');
    mark.className = ok ? 'ok' : 'no';
    mark.textContent = ok ? 'Yes' : (required ? 'NO' : 'No');
    b.appendChild(mark);
    if (detail) { b.appendChild(document.createTextNode('  ' + detail)); }
    tr.appendChild(a); tr.appendChild(b); rows.appendChild(tr);
  }


  function cssOk(prop, value) {
    return !!(window.CSS && CSS.supports && CSS.supports(prop, value));
  }

  document.getElementById('agent').textContent = navigator.userAgent;

  row('Can open the receiver page (JavaScript modules)', 'noModule' in document.createElement('script'), '', true);
  row('Understands modern JavaScript (?. ?? and more)', window.__modernJs === true, '', true);
  row('Live video connection (WebRTC)', typeof window.RTCPeerConnection === 'function', '', true);
  row('Live connection to the server (WebSocket)', typeof window.WebSocket === 'function', '', true);
  row('Can play video', !!document.createElement('video').play, '', true);

  var codecs = '';
  var h264 = false, vp8 = false;
  try {
    if (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities) {
      var list = RTCRtpReceiver.getCapabilities('video').codecs;
      for (var i = 0; i < list.length; i++) {
        if (/h264/i.test(list[i].mimeType)) h264 = true;
        if (/vp8/i.test(list[i].mimeType)) vp8 = true;
      }
      codecs = (h264 ? 'H.264 ' : '') + (vp8 ? 'VP8 ' : '');
    }
  } catch (e) {}
  row('Can show video from a phone (H.264 or VP8)', h264 || vp8, codecs || 'could not be checked', false);
  row('Approval box (dialog)', typeof HTMLDialogElement === 'function', 'if No, a simpler box is used', false);
  row('Full screen', !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen), '', false);
  row('Modern page layout (CSS inset, gap)', cssOk('inset', '0') && cssOk('gap', '1px'), 'only affects looks', false);
  row('Screen size', true, window.innerWidth + ' x ' + window.innerHeight + ' (pixel ratio ' + (window.devicePixelRatio || 1) + ')', false);

  var verdict = document.getElementById('verdict');
  if (missing === 0) {
    verdict.className = 'good';
    verdict.textContent = 'This screen should work as a MirrorLink receiver.';
  } else {
    verdict.className = 'bad';
    verdict.textContent = 'This browser is too old to be a receiver. Use a laptop with the screen plugged in by HDMI.';
  }
})();
