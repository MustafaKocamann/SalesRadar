"""All external research goes through this one Treg client."""
import os
import uuid
import json
import re
import requests

BASE = 'https://treg.to'

class Treg:
    def __init__(self):
        self.cost = 0
        self.budget = int(float(os.getenv('TREG_MAX_USD', '0.20')) * 1_000_000)
        self.calls = []
        self.blocked = False

    def call(self, tool, body, method="POST"):
        remaining = self.budget - self.cost
        if self.blocked or remaining <= 0 or len(self.calls) >= 4:
            raise RuntimeError('Research call or budget limit reached')
        entry = {'tool': tool, 'status': 'started'}
        self.calls.append(entry)
        try:
            response = requests.request(method, f'{BASE}/call/{tool}', **({'params': body} if method == 'GET' else {'json': body}), headers={
                'X-Treg-Token': os.environ['TREG_API_KEY'],
                'X-Treg-Route-Max-Cost': f'{remaining / 1_000_000:.6f}',
                **({'X-Treg-Route-Strict-Filters': '1'} if tool == 'treg.people.search' else {}),
                'X-Treg-Meta': 'feature=sales-research',
                'Idempotency-Key': str(uuid.uuid4()),
            }, timeout=75)
        except requests.RequestException:
            self.blocked = True
            entry['status'] = 'unknown charge; inspect Treg dashboard'
            raise RuntimeError('Treg connection failed; further calls stopped') from None
        charge = int(response.headers.get('X-Treg-Cost-Micro', '0'))
        self.cost += charge
        entry.update(status=response.status_code, cost_micro=charge,
                     call_id=response.headers.get('X-Treg-Call-Id'))
        if response.status_code == 202:
            self.blocked = True
            raise RuntimeError('Treg call pending; inspect dashboard before repeating')
        if not response.ok or response.headers.get('X-Treg-Upstream-Failed'):
            # Keep the detailed error in the local terminal, not the browser.
            detail = response.text[:2500]
            token = os.getenv('TREG_API_KEY', '')
            if token:
                detail = detail.replace(token, '[redacted]')
            print(f'Treg {tool}: HTTP {response.status_code}: {detail}', flush=True)
            raise RuntimeError(f'Treg tool {tool} failed (HTTP {response.status_code}); see local terminal for details')
        data = response.json()
        if isinstance(data, dict) and data.get('_treg', {}).get('incomplete'):
            raise RuntimeError('Treg returned incomplete results')
        # Routed tools have a normalized output; avoid sending raw contact data.
        return data.get('output', data) if isinstance(data, dict) else data

    def configured(self, kind, default_tool, default_body):
        tool = os.getenv(f'TREG_{kind}_TOOL', default_tool)
        method = os.getenv(f'TREG_{kind}_METHOD', 'POST').upper()
        if method not in ('GET', 'POST'):
            raise RuntimeError('Configure GET or POST for '+kind)
        template = os.getenv(f'TREG_{kind}_BODY', '')
        if template:
            def substitute(v):
                if isinstance(v, dict):
                    return {k: substitute(x) for k,x in v.items()}
                if isinstance(v, list):
                    return [substitute(x) for x in v]
                if isinstance(v, str):
                    for k,x in ({**default_body, 'query': default_body['q']} if kind == 'SEARCH' else {**default_body, 'domain': default_body['company_domain']} if kind == 'PEOPLE' else default_body).items():
                        v = v.replace('{'+k+'}', str(x))
                return v
            body = substitute(json.loads(template))
        else:
            body = default_body
        return self.call(tool, body, method)

    def search(self, query):
        return self.configured('SEARCH', 'treg.web.search', {'q': query})

    def scrape(self, url):
        return self.configured('SCRAPE', 'treg.web.extract', {'url': url})

    def company(self, domain):
        # Use documented web search until a dedicated enrichment endpoint is configured.
        if not os.getenv('TREG_COMPANY_TOOL'):
            return self.search(f'site:{domain} company overview industry headquarters products')
        return self.configured('COMPANY', '', {'domain': domain})

    def people(self, domain):
        return self.configured('PEOPLE', 'treg.people.search', {'company_domain': domain})
