// All requests use the same FastAPI server. No API keys reach the browser.
const $ = id => document.getElementById(id);
let result = null;
async function checkHealth() {
    try {
        const response = await fetch('/health');
        if (!response.ok) throw new Error('Backend unavailable');
        const data = await response.json();
        $('mode').textContent = data.demo ? 'Demo mode — fictional data, no paid API calls.' : 'Live mode — Treg and OpenAI charges may apply.';
        $('submit').disabled = false;
    } catch (error) { $('mode').textContent = 'Backend unavailable. Reload after starting FastAPI.'; }
}
function showResult(data) {
    result = data;
    $('result-title').textContent = data.company;
    $('cost').textContent = `Recorded Treg cost: $${Number(data.treg_cost_usd).toFixed(6)} · ${data.status}`;
    $('report').textContent = data.report;
    $('warnings').replaceChildren();
    for (const warning of data.warnings) {
        const p = document.createElement('p'); p.className = 'warning'; p.textContent = warning; $('warnings').append(p);
    }
    $('evidence').replaceChildren();
    for (const row of data.evidence) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `[${row.id}] ${row.source}`;
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(row.data, null, 2);
        details.append(summary, pre); $('evidence').append(details);
    }
    $('calls').textContent = JSON.stringify(data.calls, null, 2);
    document.querySelectorAll('[data-agent]').forEach(card => {
        const done = data.completed.includes(card.dataset.agent);
        card.classList.toggle('done', done);
        card.querySelector('span').textContent = done ? 'Stage finished' : 'Not completed';
    });
    $('results').hidden = false;
}
$('research-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('submit').disabled = true; $('results').hidden = true; result = null;
    $('status').className = ''; $('status').textContent = 'Research in progress… please wait.';
    document.querySelectorAll('[data-agent]').forEach(card => {card.classList.remove('done'); card.querySelector('span').textContent = 'Queued / running';});
    try {
        const response = await fetch('/research', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({company_name:$('company').value.trim()})});
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Research request failed. Check company name and server logs.');
        showResult(data);
        $('status').textContent = data.status === 'partial' ? 'Research finished with warnings. Review the evidence below.' : 'Research finished.';
    } catch (error) {
        $('status').className = 'error'; $('status').textContent = error.message;
        document.querySelectorAll('[data-agent] span').forEach(span => span.textContent = 'Status unavailable');
    } finally { $('submit').disabled = false; }
});
$('download').addEventListener('click', () => {
    if (!result) return;
    const content = result.report + '\n\n## Evidence\n' + result.evidence.map(row => `[${row.id}] ${row.source}\n${JSON.stringify(row.data,null,2)}`).join('\n\n');
    const url = URL.createObjectURL(new Blob([content], {type:'text/markdown'}));
    const link = document.createElement('a'); link.href = url; link.download = 'sales-research.md'; link.click(); URL.revokeObjectURL(url);
});
checkHealth();
