/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
import type { D1Database } from './lib/d1-adapter';
declare namespace App {
  interface Locals {
    runtime: {
      env: {
        DB: D1Database;
      };
    };
  }
}
