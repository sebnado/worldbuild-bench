---
name: world-design
description: How to think about spatial design before building — composing for the gameplay camera, orientation and landmarks, scale, density rhythm, sightlines, and space that serves the mechanics. Principles and proven spatial algorithms to explore; layout is decided at design time, not retrofitted at polish time.
---

# World Design: Space Is a Decision

A world reads as flat and arbitrary when its arrangement was never decided — props
scattered uniformly, geometry placed where it was convenient to code, a play space
that looks the same in every direction. Spatial design is deciding what goes where
and why, from the player's point of view. Make those decisions at design time (in
the PRD, before code): layout shapes the systems that build it, and it cannot be
retrofitted during polish.

This skill defines what to think about; how you achieve it is yours to choose.

## Compose for the gameplay camera

The only view that matters is the one the player actually has. A layout that looks
great from an editor god-view can be unreadable from a chase camera two meters off
the ground.

- What fills the frame in the first three seconds? That shot is the game's first
  impression — design it like one.
- At the actual camera height/FOV, is there depth layering — foreground detail,
  midground play space, background silhouette and sky — or one undifferentiated
  plane?
- Where does the horizon sit, and is there something interesting on it in every
  direction the player will commonly face?

## Orientation: the player always knows where they are

- **Landmarks**: a few large, distinct, widely visible features (each unique — a
  repeated landmark misleads). From any reachable point, can the player name their
  location and point toward the objective?
- **Directional asymmetry**: the world should look different facing north vs.
  south — asymmetric skylines, a light source with a definite direction, distinct
  edge treatments. Uniform surroundings make every wrong turn feel identical.
- **Local wayfinding**: lighting, color, and geometry can lead the eye along the
  intended path — players follow light, contrast, and converging lines without
  being told.

## Scale, proportion, and density rhythm

- Give the world a scale reference the player's own avatar/vehicle establishes —
  then keep proportions consistent with it. One out-of-scale prop breaks the whole
  illusion.
- Vary density deliberately: busy zones (detail, landmarks, action) alternating
  with quiet ones (negative space, long sightlines). Uniform density — whether
  empty or cluttered — reads as noise. The quiet stretches are what make the busy
  ones land.
- Cluster props the way the world's fiction would (things accumulate near walls,
  paths, and structures), not uniformly at random.

## Space serves the mechanics

The layout is a gameplay system, not scenery. Ask what the space must do for the
game and let that drive placement:

- Can the player read the next challenge before it arrives — corners, threats,
  goals, or decision points telegraphed by geometry and landmarks?
- Does the space shape routes and choices (cover, chokepoints, paths of least
  resistance), or is every location mechanically identical?
- Is the problem space visible (or discoverable) from the camera the player
  actually controls? Does the framing itself hint at what to do next?

## Approaches worth exploring

Suggestions, not a curriculum: techniques such as greybox blocking before the art
pass, Poisson-disc or noise-driven scattering, spline-based paths and networks,
space partitioning and room-graph generation, wave-function collapse, L-systems,
hero landmarks over procedural fill, rule-of-thirds framing and leading lines. Pick what serves the
concept, combine freely, and reach past this list when you know something stronger.

## The walk test

Before calling the world done, playtest it as a place, not a program:

- Screenshot the actual gameplay camera at 4–5 key moments — does each frame look
  composed, with layered depth and a clear focal point?
- Spin the camera 360° from the center and from the edges: is any direction dead,
  repeated, or unreadable?
- Could a player who just spawned point toward the goal? Could they retrace their
  path?
- Does the layout visibly serve the core mechanic (challenges readable, routes
  shaped, goals framed) rather than merely hosting it?
