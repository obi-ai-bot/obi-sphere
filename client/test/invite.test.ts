// Invite links as sphere-api.md section 4 writes them, and as Oby writes and reads them.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InviteLinkError, formatInviteLink, parseInviteLink, sphereBase } from "../src/index.ts";

test("an open invitation's link", () => {
  const l = parseInviteLink("https://sphere.example.com/join#sphere=acme&name=Acme%20Team&by=ada&id=inv-1&secret=s3cr%2Bt");
  assert.deepEqual(l, { base: "https://sphere.example.com", sphere: "acme", id: "inv-1", secret: "s3cr+t", name: "Acme Team", by: "ada" });
});

test("`+` is a plus, the first occurrence wins, unknown keys are ignored", () => {
  const l = parseInviteLink("http://127.0.0.1:8792/join#sphere=a&id=i&secret=a+b&secret=other&extra=1&name=x+y");
  assert.equal(l.secret, "a+b");
  assert.equal(l.name, "x+y");
  assert.equal(l.base, "http://127.0.0.1:8792");
});

test("a named invitation has both `for` and `obi`", () => {
  const l = parseInviteLink("https://s.example.com/join#sphere=deskree&name=Deskree&by=wellington&for=ernesto&obi=obi-ernesto&id=i&secret=s");
  assert.equal(l.owner, "ernesto");
  assert.equal(l.obi, "obi-ernesto");
  assert.throws(() => parseInviteLink("https://s.example.com/join#sphere=d&for=ernesto&id=i&secret=s"), InviteLinkError);
  assert.throws(() => parseInviteLink("https://s.example.com/join#sphere=d&obi=obi-e&id=i&secret=s"), InviteLinkError);
});

test("links this client refuses", () => {
  for (const bad of [
    "https://s.example.com/join",
    "https://s.example.com/join#sphere=d&id=i",
    "https://s.example.com/join#sphere=&id=i&secret=s",
    "http://s.example.com/join#sphere=d&id=i&secret=s",
    "https://s.example.com/x/join#sphere=d&id=i&secret=s",
    "https://s.example.com/join?a=b#sphere=d&id=i&secret=s",
    "https://me@s.example.com/join#sphere=d&id=i&secret=s",
    "https://s.example.com/join#sphere=d&id=i&secret=%E0%A4%A",
    "oby://join/s.example.com#sphere=d&id=i&secret=s",
  ]) assert.throws(() => parseInviteLink(bad), InviteLinkError, bad);
  assert.equal(sphereBase("http://[::1]:8792"), "http://[::1]:8792");
  assert.equal(sphereBase("http://localhost:8792/"), "http://localhost:8792");
});

test("a link written and read again is the same", () => {
  const link = { base: "https://s.example.com", sphere: "acme", name: "A & B = C+", by: "ada", owner: "bea", obi: "obi-bea", id: "inv-2", secret: "x".repeat(43) };
  const text = formatInviteLink(link);
  assert.ok(text.startsWith("https://s.example.com/join#sphere=acme&name=A%20%26%20B%20%3D%20C%2B&by=ada&for=bea&obi=obi-bea&id=inv-2&secret="));
  assert.deepEqual(parseInviteLink(text), link);
});
