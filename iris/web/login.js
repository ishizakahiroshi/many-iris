'use strict';
document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('ui-key');
  const result = document.getElementById('login-result');
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/session', {method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'same-origin', body: JSON.stringify({key: input.value})});
    input.value = '';
    if (response.ok) { location.reload(); return; }
    result.textContent = '本人用キーを確認してください。MCP用の資格は使用できません。';
  } catch { result.textContent = '接続できません。キーを再送する前に、Many Irisが起動しているか確認してください。'; }
  finally { button.disabled = false; }
});
