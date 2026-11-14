import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Gebäude-Cache: Kacheln älter als 30 Tage löschen.
crons.daily("cleanup building cache", { hourUTC: 3, minuteUTC: 17 }, internal.buildings.cleanup, {});

export default crons;
