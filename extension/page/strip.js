// Elide · Prevent switch. Registered just before page/youtube-data.js while Prevent is on;
// tells it to delete ad schedules instead of only reading them.
window[Symbol.for('elide.strip')] = true;
