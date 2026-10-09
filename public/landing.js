const canCapture = Boolean(navigator.mediaDevices?.getDisplayMedia);
if (!canCapture) {
  const tag = document.getElementById('send-tag');
  tag.textContent = 'Sender: screen capture not available in this browser';
  tag.classList.add('warn');
}
