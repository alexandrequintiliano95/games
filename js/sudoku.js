/* ============================================================
   Sudoku
   O tabuleiro é gerado na hora: preenche uma grade completa,
   depois retira números enquanto a solução continuar única.
   ============================================================ */
(function () {
    'use strict';

    const SIZE = 9;
    const CELLS = 81;
    const ALL = 0x3FE;              // bits 1..9 ligados
    const STORAGE_PREFIX = 'sudoku-best-';
    const SAVE_KEY = 'sudoku-partida';

    // dicas = quantos números já vêm preenchidos
    const LEVELS = {
        facil: { dicas: 44, nome: 'Fácil' },
        medio: { dicas: 34, nome: 'Médio' },
        dificil: { dicas: 28, nome: 'Difícil' }
    };

    const DEFAULT_LEVEL = 'facil';

    const rowOf = index => Math.floor(index / SIZE);
    const colOf = index => index % SIZE;
    const boxOf = index => Math.floor(rowOf(index) / 3) * 3 + Math.floor(colOf(index) / 3);
    const bitOf = value => 1 << value;
    const valueOf = bit => 31 - Math.clz32(bit);

    const countBits = mask => {
        let total = 0;
        let rest = mask;
        while (rest) {
            rest &= rest - 1;
            total += 1;
        }
        return total;
    };

    const formatTime = ms => {
        const total = Math.floor(ms / 1000);
        const minutes = String(Math.floor(total / 60)).padStart(2, '0');
        const seconds = String(total % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    };

    const shuffled = list => {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    };

    /* --- Máscaras de uso por linha, coluna e quadrante --- */
    function marks(grid) {
        const rows = new Uint16Array(SIZE);
        const cols = new Uint16Array(SIZE);
        const boxes = new Uint16Array(SIZE);
        for (let i = 0; i < CELLS; i += 1) {
            const value = grid[i];
            if (!value) continue;
            const bit = bitOf(value);
            rows[rowOf(i)] |= bit;
            cols[colOf(i)] |= bit;
            boxes[boxOf(i)] |= bit;
        }
        return { rows, cols, boxes };
    }

    // Percorre a grade escolhendo sempre a casa com menos possibilidades.
    // `onSolution` devolve true quando já viu o bastante e pode parar.
    function search(grid, onSolution, randomize) {
        const { rows, cols, boxes } = marks(grid);

        const step = () => {
            let target = -1;
            let targetMask = 0;
            let fewest = 10;

            for (let i = 0; i < CELLS; i += 1) {
                if (grid[i]) continue;
                const mask = ALL & ~(rows[rowOf(i)] | cols[colOf(i)] | boxes[boxOf(i)]);
                const total = countBits(mask);
                if (total === 0) return false;      // sem saída: volta atrás
                if (total < fewest) {
                    fewest = total;
                    target = i;
                    targetMask = mask;
                    if (total === 1) break;
                }
            }

            if (target === -1) return onSolution();  // grade cheia

            const row = rowOf(target);
            const col = colOf(target);
            const box = boxOf(target);
            let options = [];
            let rest = targetMask;
            while (rest) {
                const bit = rest & -rest;
                rest ^= bit;
                options.push(bit);
            }
            if (randomize) options = shuffled(options);

            for (const bit of options) {
                grid[target] = valueOf(bit);
                rows[row] |= bit;
                cols[col] |= bit;
                boxes[box] |= bit;

                const stop = step();

                grid[target] = 0;
                rows[row] ^= bit;
                cols[col] ^= bit;
                boxes[box] ^= bit;

                if (stop) {
                    grid[target] = valueOf(bit);   // mantém para quem quer a solução
                    return true;
                }
            }
            return false;
        };

        return step();
    }

    function countSolutions(grid, limit) {
        const work = grid.slice();
        let found = 0;
        search(work, () => {
            found += 1;
            return found >= limit;
        }, false);
        return found;
    }

    function fullGrid() {
        const grid = new Uint8Array(CELLS);
        search(grid, () => true, true);
        return grid;
    }

    // Tira números em ordem aleatória, desfazendo a retirada sempre que a
    // solução deixaria de ser única.
    function makePuzzle(dicas) {
        const solution = fullGrid();
        const puzzle = solution.slice();
        let restantes = CELLS;

        for (const index of shuffled(Array.from({ length: CELLS }, (unused, i) => i))) {
            if (restantes <= dicas) break;
            const saved = puzzle[index];
            puzzle[index] = 0;
            if (countSolutions(puzzle, 2) === 1) restantes -= 1;
            else puzzle[index] = saved;
        }

        return { puzzle, solution, dicas: restantes };
    }

    /* ============================================================
       Interface
       ============================================================ */
    function createSudoku(root) {
        const boardEl = root.querySelector('[data-sudoku-board]');
        const padEl = root.querySelector('[data-sudoku-pad]');
        const timeEl = root.querySelector('[data-sudoku-time]');
        const leftEl = root.querySelector('[data-sudoku-left]');
        const bestEl = root.querySelector('[data-sudoku-best]');
        const statusEl = root.querySelector('[data-sudoku-status]');
        const notesBtn = root.querySelector('[data-sudoku-notes]');
        const eraseBtn = root.querySelector('[data-sudoku-erase]');
        const newBtn = (root.parentElement || root).querySelector('[data-sudoku-new]');
        const levelBtns = Array.from(root.querySelectorAll('[data-sudoku-level]'));

        if (!boardEl) return;

        let level = DEFAULT_LEVEL;
        let puzzle = new Uint8Array(CELLS);      // números fixos (0 = vazio)
        let values = new Uint8Array(CELLS);      // o que o jogador escreveu
        let notes = [];                          // máscara de anotações por casa
        let cellEls = [];
        let noteEls = [];
        let selected = -1;
        let notesMode = false;
        let solved = false;
        let elapsed = 0;
        let startedAt = 0;
        let ticker = 0;

        const isFixed = index => puzzle[index] !== 0;
        const valueAt = index => puzzle[index] || values[index];

        /* --- Conflitos e progresso --- */
        const conflicts = () => {
            const bad = new Set();
            // linhas, colunas e quadrantes em uma passada só
            const byRow = new Map();
            const byCol = new Map();
            const byBox = new Map();
            const push = (map, key, index) => {
                const list = map.get(key) || [];
                list.push(index);
                map.set(key, list);
            };
            for (let i = 0; i < CELLS; i += 1) {
                const value = valueAt(i);
                if (!value) continue;
                push(byRow, rowOf(i) + ':' + value, i);
                push(byCol, colOf(i) + ':' + value, i);
                push(byBox, boxOf(i) + ':' + value, i);
            }
            [byRow, byCol, byBox].forEach(map => {
                map.forEach(list => {
                    if (list.length > 1) list.forEach(i => bad.add(i));
                });
            });
            return bad;
        };

        const remaining = () => {
            let left = 0;
            for (let i = 0; i < CELLS; i += 1) if (!valueAt(i)) left += 1;
            return left;
        };

        /* --- Desenho --- */
        function buildBoard() {
            boardEl.innerHTML = '';
            cellEls = [];
            noteEls = [];

            for (let i = 0; i < CELLS; i += 1) {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'sudoku-cell';
                cell.dataset.index = i;
                cell.innerHTML = '<span class="sudoku-value"></span><span class="sudoku-notes"></span>';
                cell.addEventListener('click', () => select(i));
                boardEl.appendChild(cell);
                cellEls.push(cell);
                noteEls.push(cell.querySelector('.sudoku-notes'));
            }
        }

        function render() {
            const bad = conflicts();
            const focoValor = selected >= 0 ? valueAt(selected) : 0;

            cellEls.forEach((cell, i) => {
                const value = valueAt(i);
                const valueEl = cell.firstElementChild;
                valueEl.textContent = value || '';

                cell.classList.toggle('fixed', isFixed(i));
                cell.classList.toggle('selected', i === selected);
                cell.classList.toggle('conflict', bad.has(i));
                cell.classList.toggle('peer', selected >= 0 && i !== selected && (
                    rowOf(i) === rowOf(selected) || colOf(i) === colOf(selected) || boxOf(i) === boxOf(selected)
                ));
                cell.classList.toggle('same', Boolean(focoValor) && value === focoValor && i !== selected);

                // anotações
                const mask = notes[i] || 0;
                if (value || !mask) {
                    noteEls[i].textContent = '';
                } else {
                    noteEls[i].innerHTML = Array.from({ length: SIZE }, (unused, n) => (
                        `<i>${mask & bitOf(n + 1) ? n + 1 : ''}</i>`
                    )).join('');
                }

                cell.setAttribute('aria-label',
                    `Linha ${rowOf(i) + 1}, coluna ${colOf(i) + 1}${value ? ', ' + value : ', vazia'}`);
            });

            // números já usados nove vezes somem do teclado
            const usados = new Uint8Array(SIZE + 1);
            for (let i = 0; i < CELLS; i += 1) {
                const value = valueAt(i);
                if (value) usados[value] += 1;
            }
            padEl.querySelectorAll('[data-sudoku-number]').forEach(btn => {
                const n = Number(btn.dataset.sudokuNumber);
                btn.classList.toggle('done', usados[n] >= SIZE);
            });

            if (leftEl) leftEl.textContent = remaining();
            updateTime();
        }

        function select(index) {
            selected = index;
            render();
        }

        /* --- Jogadas --- */
        function place(number) {
            if (solved || selected < 0 || isFixed(selected)) return;

            if (notesMode) {
                if (values[selected]) return;                    // casa já tem número
                notes[selected] = (notes[selected] || 0) ^ bitOf(number);
            } else {
                if (values[selected] === number) {
                    values[selected] = 0;                        // toca de novo para apagar
                } else {
                    values[selected] = number;
                    notes[selected] = 0;
                    clearNotesAround(selected, number);
                }
                if (!startedAt) startTimer();
            }
            save();
            render();
            checkSolved();
        }

        // Ao fixar um número, ele some das anotações da linha, coluna e quadrante
        function clearNotesAround(index, number) {
            const bit = bitOf(number);
            for (let i = 0; i < CELLS; i += 1) {
                if (i === index || !notes[i]) continue;
                if (rowOf(i) === rowOf(index) || colOf(i) === colOf(index) || boxOf(i) === boxOf(index)) {
                    notes[i] &= ~bit;
                }
            }
        }

        function erase() {
            if (solved || selected < 0 || isFixed(selected)) return;
            values[selected] = 0;
            notes[selected] = 0;
            save();
            render();
        }

        function move(dx, dy) {
            if (selected < 0) {
                select(0);
                return;
            }
            const col = Math.min(SIZE - 1, Math.max(0, colOf(selected) + dx));
            const row = Math.min(SIZE - 1, Math.max(0, rowOf(selected) + dy));
            select(row * SIZE + col);
        }

        function setNotesMode(on) {
            notesMode = on;
            if (notesBtn) {
                notesBtn.setAttribute('aria-pressed', String(on));
                notesBtn.classList.toggle('on', on);
            }
        }

        /* --- Cronômetro --- */
        const currentElapsed = () => elapsed + (startedAt ? Date.now() - startedAt : 0);

        function startTimer() {
            if (solved) return;
            startedAt = Date.now();
            clearInterval(ticker);
            ticker = setInterval(updateTime, 250);
        }

        function stopTimer() {
            if (startedAt) {
                elapsed += Date.now() - startedAt;
                startedAt = 0;
            }
            clearInterval(ticker);
            ticker = 0;
        }

        function updateTime() {
            if (timeEl) timeEl.textContent = formatTime(currentElapsed());
        }

        /* --- Recorde por dificuldade --- */
        function readBest() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_PREFIX + level) || 'null');
            } catch (error) {
                return null;
            }
        }

        function showBest() {
            if (!bestEl) return;
            const best = readBest();
            bestEl.innerHTML = best
                ? `<i class="fas fa-trophy"></i> Melhor: ${formatTime(best.ms)}`
                : '';
        }

        function saveBest(ms) {
            try {
                localStorage.setItem(STORAGE_PREFIX + level, JSON.stringify({ ms }));
            } catch (error) {
                /* sem localStorage o jogo segue normalmente */
            }
        }

        function setStatus(text, isWin) {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.classList.toggle('win', Boolean(isWin));
        }

        function checkSolved() {
            if (remaining() > 0 || conflicts().size > 0) return;

            solved = true;
            stopTimer();
            const time = currentElapsed();
            boardEl.classList.add('solved');
            setStatus(`Resolvido em ${formatTime(time)}!`, true);

            const best = readBest();
            if (!best || time < best.ms) saveBest(time);
            showBest();
            clearSave();
        }

        /* --- Partida em andamento (o atalho do iPhone pode ser fechado) --- */
        function save() {
            if (solved) return;
            try {
                localStorage.setItem(SAVE_KEY, JSON.stringify({
                    level,
                    puzzle: Array.from(puzzle),
                    values: Array.from(values),
                    notes,
                    ms: currentElapsed()
                }));
            } catch (error) {
                /* sem localStorage a partida simplesmente não é retomada */
            }
        }

        function clearSave() {
            try {
                localStorage.removeItem(SAVE_KEY);
            } catch (error) {
                /* nada a fazer */
            }
        }

        function readSave() {
            try {
                const data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
                if (!data || !LEVELS[data.level]) return null;
                if (!Array.isArray(data.puzzle) || data.puzzle.length !== CELLS) return null;
                if (!Array.isArray(data.values) || data.values.length !== CELLS) return null;
                return data;
            } catch (error) {
                return null;
            }
        }

        /* --- Ciclo de vida --- */
        function startGame(saved) {
            stopTimer();
            solved = false;
            selected = -1;
            setNotesMode(false);
            boardEl.classList.remove('solved');

            if (saved) {
                level = saved.level;
                puzzle = Uint8Array.from(saved.puzzle);
                values = Uint8Array.from(saved.values);
                notes = Array.isArray(saved.notes) ? saved.notes.slice(0, CELLS) : [];
                elapsed = Number(saved.ms) || 0;
            } else {
                const gerado = makePuzzle(LEVELS[level].dicas);
                puzzle = gerado.puzzle;
                values = new Uint8Array(CELLS);
                notes = new Array(CELLS).fill(0);
                elapsed = 0;
            }

            startedAt = 0;
            levelBtns.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.sudokuLevel === level)));
            setStatus('Toque numa casa e escolha o número.');
            render();
            showBest();
            if (saved && elapsed > 0) startTimer();
        }

        function newGame() {
            clearSave();
            startGame(null);
        }

        function setLevel(name) {
            if (!LEVELS[name] || name === level) return;
            level = name;
            newGame();
        }

        /* --- Ligações --- */
        levelBtns.forEach(btn => btn.addEventListener('click', () => setLevel(btn.dataset.sudokuLevel)));
        if (newBtn) newBtn.addEventListener('click', newGame);
        if (eraseBtn) eraseBtn.addEventListener('click', erase);
        if (notesBtn) notesBtn.addEventListener('click', () => setNotesMode(!notesMode));

        padEl.querySelectorAll('[data-sudoku-number]').forEach(btn => {
            btn.addEventListener('click', () => place(Number(btn.dataset.sudokuNumber)));
        });

        document.addEventListener('keydown', event => {
            if (event.key >= '1' && event.key <= '9') {
                event.preventDefault();
                place(Number(event.key));
                return;
            }
            const setas = {
                ArrowUp: [0, -1],
                ArrowDown: [0, 1],
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0]
            }[event.key];
            if (setas) {
                event.preventDefault();
                move(setas[0], setas[1]);
                return;
            }
            if (event.key === 'Backspace' || event.key === 'Delete' || event.key === '0') {
                event.preventDefault();
                erase();
                return;
            }
            if (event.key === 'n' || event.key === 'N') {
                event.preventDefault();
                setNotesMode(!notesMode);
            }
        });

        buildBoard();
        startGame(readSave());
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-sudoku]').forEach(createSudoku);
    });
})();
