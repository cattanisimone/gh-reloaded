# Engine decision

Numbers: `results/report.md` (full run: sizes 8 to 150, 5 seeds, 9 kinds, both card sizes). Rule applied in order: correctness gate, readability, stability and latency, footprint.

- **Correctness gate**: custom, Dagre, d3-dag, ELK pass; Graphviz draws 314 edges through a card (its routes ignore the fixed card size), so it fails the "no edge through a card" requirement.
- **Readability**: custom has 66.5 crossings per fixture against 348 today, 72 (ELK), 81 (d3-dag), 84 (Dagre); Graphviz is lower (50) but fails the gate. Custom keeps the critical path on one row (0 px deviation against 156 to 281 px for the others) and has 4.5 shared stretches against 38 today.
- **Stability and latency**: custom is the only engine that keeps the order when a card is removed (0 inversions, others 2 to 127), p95 33 ms at 150 cards and 14 ms at 80, under the 50 ms target.
- **Footprint**: custom is 25 KB of plain scripts; every library is above the 100 KB stop (Dagre 277, d3-dag 140, Graphviz 796, ELK 1572 KB).

Custom wins the gate, readability, stability and footprint, so no library enters the extension and the 100 KB stop does not apply. Rejected: Graphviz (card hits, size), ELK (size, instability), d3-dag (latency 4.4 s p95 at 150), Dagre (size, no stability, critical path not straight).

Back edges (cycles) leave the right side of the source, run down the gap beside its column and under every card, and rise in the gap in front of the target, so they pass no card.
