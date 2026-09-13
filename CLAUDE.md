# Working agreements

## Token efficiency
- Answer directly. No restating the request, no preamble before tool calls.
- Read only the lines/ranges needed; don't read a whole file when an offset+limit or a targeted grep answers the question.
- Use Grep/Glob for search instead of listing or reading directories wholesale.
- Delegate broad or open-ended exploration (multi-file searches, wide research) to a subagent so raw intermediate output doesn't fill the main context.
- Summarize command/tool output instead of pasting it verbatim, unless the user asked for the raw output.
