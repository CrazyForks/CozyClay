import { registerElementKind } from '../elements.js';
import { wrapAngle } from '../../scene-objects.js';

const elements = [
  ...['anchorX', 'anchorZ', 'rotationDeg'].map(field => ({ path: `motion.take.${field}`, type: 'number', agentExposure: 'patch' })),
  { path: 'motion.take.prompt', type: 'string', agentExposure: 'patch' },
  { path: 'motion.ikKeys', type: 'array', agentExposure: 'readonly' },
  { path: 'motion.takeRecipe', type: 'object', agentExposure: 'readonly' },
  { path: 'motion.takeVersions', type: 'array', agentExposure: 'readonly' },
];
registerElementKind('motion', { collection: true, elements, normalize: row => ({ ...row, take: row.take && { ...row.take,
  anchorX: Math.max(-240, Math.min(240, row.take.anchorX ?? 0)), anchorZ: Math.max(-240, Math.min(240, row.take.anchorZ ?? 0)),
  rotationDeg: wrapAngle(row.take.rotationDeg ?? 0),
} }) });
