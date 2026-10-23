/* global module */
"use strict";

function range(from, to) {
  const versions = [];
  for (let version = from; version <= to; version += 1) {
    versions.push(String(version));
  }
  return versions;
}

function agent(versions) {
  return {
    versions,
    usage_global: {},
    release_date: {},
  };
}

module.exports.agents = {
  android: agent(range(4, 143)),
  and_chr: agent(range(56, 143)),
  and_ff: agent(range(56, 148)),
  and_qq: agent(range(1, 14)),
  and_uc: agent(range(1, 15)),
  baidu: agent(range(0, 13)),
  bb: agent(range(1, 10)),
  chrome: agent(range(1, 143)),
  edge: agent(range(12, 143)),
  firefox: agent(range(1, 148)),
  ie: agent(range(6, 11)),
  ie_mob: agent(range(8, 11)),
  ios_saf: agent(range(8, 27)),
  kaios: agent(range(1, 3)),
  op_mob: agent(range(10, 80)),
  opera: agent(range(10, 120)),
  safari: agent(range(8, 27)),
  samsung: agent(range(4, 28)),
};
