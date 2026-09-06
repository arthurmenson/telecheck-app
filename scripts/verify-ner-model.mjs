// Run after build; in CI also run inside the runtime image with --network none.
import { initializeNer, classifyEntities, getNerReadiness } from '../dist/lib/pii-screener/ner.js';
await initializeNer();
const tail = 'I have a mild headache today. '.repeat(65) + 'My name is Akosua Adjei and I live at 55 Liberty Road, Accra.';
const hits = await classifyEntities(tail);
if (!hits.some((hit) => hit.entityType === 'PERSON' && hit.match.includes('Akosua')) || !hits.some((hit) => hit.entityType === 'LOCATION' && hit.match.includes('Liberty'))) throw new Error('ner_offline_probe_failed');
console.log(JSON.stringify(getNerReadiness()));
