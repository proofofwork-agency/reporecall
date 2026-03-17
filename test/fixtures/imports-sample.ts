import { foo, bar } from "./module";
import Foo from "./module";
import * as ns from "./module";
import { foo as bar2 } from "./module";
import type { Foo as FooType } from "./module";
import Default, { named, another } from "./module";
import express from "express";

export { reExported } from "./re-export-source";

export function hello() {
  return "hello";
}
