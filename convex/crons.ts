import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Gebäude-Cache: Kacheln älter als 30 Tage löschen.
crons.daily("cleanup building cache", { hourUTC: 3, minuteUTC: 17 }, internal.buildings.cleanup, {});
// Grenzen der Ortsteile: Kacheln älter als 90 Tage löschen.
crons.daily("cleanup boundary cache", { hourUTC: 3, minuteUTC: 37 }, internal.areas.cleanup, {});

export default crons;
