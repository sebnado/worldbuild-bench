---
name: game-quality
description: The quality bar — what separates a shippable game from a prototype — across lighting, world geometry, VFX, audio, game feel, UI, and performance. Outcomes to hit on every front, with technique families worth exploring; how you hit them is your call.
---

# The Quality Bar

You are not building a tech demo that minimally satisfies a checklist. The bar is a
game a player would voluntarily keep playing: readable at a glance, juicy to interact
with, coherent as a world. Flat-shaded boxes on a green plane do not clear that
bar. Everything runs offline from the
bundled `lib/three/` (the full `examples/jsm/` addons tree is available) and the
WebAudio API. No external assets exist — geometry, materials, and audio are all made
in code, which is a style to embrace (clean, bold, stylized) rather than apologize for.

Each section below sets the bar for one front and names technique families worth
exploring — how you hit the bar is yours to decide. Nothing ships as a placeholder:
every asset the player sees or hears — geometry, materials, music, sound — is a
final product, composed and finished to the best of your ability, not a stand-in.
For the arrangement of the world itself, see the world-design skill.

## Lighting & atmosphere (the cheapest 10x visual upgrade)

The bar: the scene reads as *lit* — a definite light direction, shadows that ground
objects, depth cues receding toward a designed sky, and a deliberate palette that
reads as art direction rather than defaults. Get color management right (output
color space, tone mapping) so the colors that ship are the colors you chose.

Worth exploring: physically-based materials and HDR lighting, image-based /
environment lighting, global-illumination approximations (ambient occlusion, light
probes), screen-space reflections, area lights, shadow mapping, fog matched to the
sky, gradient or procedural skies, emissive accents.

## Geometry & world building

The bar: shapes with designed silhouettes and materials that read as finished art
at gameplay distance — a world that looks authored, not accidental. Repeated
elements vary enough that the repetition doesn't read.

Worth exploring: procedural geometry and procedural texturing (generated color /
normal / roughness maps — made at runtime or baked to files in `assets/` during
the build), composition and sculpting of primitives, signed-distance-field
modeling, instancing and geometry merging, per-instance variation,
level-of-detail.

## VFX, shaders, post-processing

The bar: the picture *moves* — impacts burst, speed leaves traces, the objects that
matter draw the eye. Every effect serves a moment the player cares about; nothing
runs as decoration for its own sake.

Worth exploring: GPU-instanced or pooled particle systems, trails, small targeted
custom shaders where the player actually looks, a restrained post-processing chain.

## Animation & motion

The bar: things that move look alive. Locomotion reads as locomotion — parts that
should articulate do, secondary motion follows — never a statue sliding across the
floor. Motion has weight (acceleration, lean, recoil, follow-through), and births
and deaths are animated events, not object removal.

Worth exploring: procedural animation, skeletal or keyframe animation, inverse
kinematics, physics-driven secondary motion, squash and stretch.

## Audio (WebAudio, all synthesized)

Sound is a design layer, not a checklist. Decide a sonic palette that matches the
world (what does this place sound like?), let intensity follow game state (layers
and tempo rise with the stakes), keep a mix hierarchy (music ducks under SFX, SFX
under stingers), and use silence deliberately. Aim for music and effects that sound
produced — composed, layered, mixed; a player should assume they are hearing
crafted audio, not raw oscillators.

Environment facts: one `AudioContext`, unlocked on the first user input (browsers
block autoplay before a gesture); route everything through a master gain.

Worth exploring: synthesis for SFX (subtractive, FM, physical modeling),
spatial/positional audio, convolution reverb (impulse responses can be generated in
code), generative or adaptive layered music, mapping continuous sounds to game
state, randomized variation so repeated sounds don't fatigue.

## Game feel ("juice") — the difference players actually notice

The bar: every interaction acknowledges the player. Nothing pops into existence
unanimated, nothing important happens without feedback the player can feel, and the
big moments (wins, losses, near-misses) have anticipation and payoff.

Worth exploring: reactive cameras (smoothed follow, speed response, impact shake),
spring-damper motion, tweened transitions, layered hit feedback (visual, camera,
and audio landing together).

## UI/HUD

The bar: every state — menu, countdown, playing, paused, won, lost — is a designed
screen with readable hierarchy, never an `alert()` or raw unstyled text. Values the
player watches visibly react when they change. (A DOM overlay usually out-typesets
canvas text for the same effort — your call.)

## Performance (60 fps is a feature)

The bar: a steady frame rate on a mid-range machine, verified in a playtest —
`renderer.info.render.calls` tells the truth about draw calls.

Known traps: movement must be delta-time-based, with dt clamped so a backgrounded
tab doesn't teleport physics on return; per-frame allocations in hot loops kill
frame pacing — pool and reuse; unbatched repeated geometry multiplies draw calls.

## Scope discipline

If you cannot finish everything well, cut whole features cleanly — fewer things,
finished — instead of shipping everything at prototype quality.
