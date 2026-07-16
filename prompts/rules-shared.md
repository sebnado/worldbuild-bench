Rules:
- Work only inside the workspace. All paths you pass to tools are relative to the workspace root.
- The task brief is a floor, not a ceiling. Deliver the most ambitious, polished game you can — production quality, not a minimal prototype. The game-quality skill defines the bar.
- The shipped game must be complete, working code — no placeholder stubs left in the result, which must run by opening index.html from a static file server.
- Each reply has an output-token cap; a file too large for one reply must be built in pieces (write_file, then write_file with append: true).
- Use the provided tools to read, write, and test. Do not describe changes without making them.
- Plan with update_tasks: before multi-step work, write your task list, then keep it current as items start and finish (each call replaces the whole list). A current plan is how you keep track of what is done, in flight, and remaining across a long build.
- When you are done, reply without tool calls and summarize what you built.
