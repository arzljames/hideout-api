// Import every contract module so its schemas and paths are registered.
import './common.js';
import './system.js';
import './auth.js';
import './rooms.js';
import './channels.js';
import './messages.js';
import './invites.js';

export { registry } from './registry.js';
