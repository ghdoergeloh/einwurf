/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as areaGeo from "../areaGeo.js";
import type * as areaStore from "../areaStore.js";
import type * as areas from "../areas.js";
import type * as buildings from "../buildings.js";
import type * as campaigns from "../campaigns.js";
import type * as cells from "../cells.js";
import type * as crons from "../crons.js";
import type * as marks from "../marks.js";
import type * as migrations from "../migrations.js";
import type * as notes from "../notes.js";
import type * as osm from "../osm.js";
import type * as status from "../status.js";
import type * as validation from "../validation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  areaGeo: typeof areaGeo;
  areaStore: typeof areaStore;
  areas: typeof areas;
  buildings: typeof buildings;
  campaigns: typeof campaigns;
  cells: typeof cells;
  crons: typeof crons;
  marks: typeof marks;
  migrations: typeof migrations;
  notes: typeof notes;
  osm: typeof osm;
  status: typeof status;
  validation: typeof validation;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
