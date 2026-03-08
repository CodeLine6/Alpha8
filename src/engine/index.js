/**
 * Engine Module barrel export.
 * @module engine
 */

export { ExecutionEngine } from './execution-engine.js';
export { SignalConsensus } from './signal-consensus.js';
export { createOrder, transitionOrder, isTerminal } from './order-state-machine.js';