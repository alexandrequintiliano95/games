/* ============================================================
   Jogo da sequência numérica — quebra-cabeça deslizante
   O tabuleiro começa embaralhado e as peças deslizam para os
   espaços vazios até ficarem em ordem crescente.
   ============================================================ */
(function () {
    'use strict';

    const sequence = (first, last) => {
        const list = [];
        for (let n = first; n <= last; n += 1) list.push(String(n));
        return list;
    };

    // labels = peças na ordem correta; o que sobrar de casa vira espaço vazio
    const MODES = {
        original: { cols: 3, rows: 4, labels: sequence(1, 9).concat('0', '*') },
        classico: { cols: 3, rows: 3, labels: sequence(1, 8) },
        dificil: { cols: 4, rows: 4, labels: sequence(1, 15) }
    };

    // O asterisco da fonte fica pequeno e torto dentro do disco: desenhamos um
    // no lugar, com as seis hastes saindo do centro.
    const SYMBOLS = {
        '*': '<svg class="puzzle-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
            + '<g stroke="currentColor" stroke-width="3" stroke-linecap="round">'
            + '<line x1="12" y1="3.6" x2="12" y2="20.4" />'
            + '<line x1="4.73" y1="7.8" x2="19.27" y2="16.2" />'
            + '<line x1="4.73" y1="16.2" x2="19.27" y2="7.8" />'
            + '</g></svg>'
    };

    const DEFAULT_MODE = 'original';
    const STORAGE_PREFIX = 'sequencia-best-';
    const DIRECTIONS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

    const formatTime = ms => {
        const total = Math.floor(ms / 1000);
        const minutes = String(Math.floor(total / 60)).padStart(2, '0');
        const seconds = String(total % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    };

    function createPuzzle(root) {
        const modal = root.closest('.modal');
        // O botão de embaralhar fica no rodapé, fora do tabuleiro
        const scope = modal || root.parentElement || root;
        const boardEl = root.querySelector('[data-puzzle-board]');
        const movesEl = root.querySelector('[data-puzzle-moves]');
        const movesLabelEl = root.querySelector('[data-puzzle-moves-label]');
        const timeEl = root.querySelector('[data-puzzle-time]');
        const bestEl = root.querySelector('[data-puzzle-best]');
        const statusEl = root.querySelector('[data-puzzle-status]');
        const shuffleBtn = scope.querySelector('[data-puzzle-shuffle]');
        const modeBtns = Array.from(root.querySelectorAll('[data-puzzle-mode]'));

        if (!boardEl) return;

        let mode = DEFAULT_MODE;
        let config = MODES[mode];
        let board = [];             // rótulo da peça ou null (espaço vazio)
        let tiles = new Map();      // rótulo -> elemento
        let cellEls = [];
        let activeBlank = 0;        // espaço usado pelas setas do teclado
        let moves = 0;
        let elapsed = 0;            // tempo acumulado enquanto o modal esteve aberto
        let startedAt = 0;          // marca do relógio quando o cronômetro está correndo
        let ticker = 0;
        let solved = false;
        let visible = false;

        const cellCount = () => config.cols * config.rows;
        const tileCount = () => config.labels.length;
        const colOf = index => index % config.cols;
        const rowOf = index => Math.floor(index / config.cols);
        // O asterisco é lido por extenso pelos leitores de tela
        const spoken = label => (label === '*' ? 'asterisco' : label);

        // Quando a sequência não é uma contagem simples, o objetivo vai escrito
        const goalHint = () => {
            const ascending = config.labels.every((label, index) => (
                /^\d+$/.test(label) && (index === 0 || Number(label) > Number(config.labels[index - 1]))
            ));
            return ascending ? 'em ordem crescente' : `na ordem ${config.labels.join(' ')}`;
        };

        /* --- Estado --- */
        const isSolved = () => board.every((value, index) => (
            index < tileCount() ? value === config.labels[index] : value === null
        ));

        const neighbours = index => {
            const column = colOf(index);
            const row = rowOf(index);
            return DIRECTIONS
                .map(d => ({ column: column + d.dx, row: row + d.dy }))
                .filter(p => p.column >= 0 && p.column < config.cols && p.row >= 0 && p.row < config.rows)
                .map(p => p.row * config.cols + p.column);
        };

        /* --- Movimentos --- */
        // Devolve o índice do espaço vazio vizinho naquela direção, ou -1.
        const blankNext = (index, dx, dy) => {
            const column = colOf(index) + dx;
            const row = rowOf(index) + dy;
            if (column < 0 || column >= config.cols || row < 0 || row >= config.rows) return -1;
            const target = row * config.cols + column;
            return board[target] === null ? target : -1;
        };

        // Move uma peça por vez para o vizinho vazio — nada de empurrar fileira.
        const moveTile = (index, target) => {
            board[target] = board[index];
            board[index] = null;
            activeBlank = index;
            registerMove(1);
        };

        // Setas do teclado: a peça anda no sentido indicado, ocupando o espaço ativo.
        const keyMove = (dx, dy) => {
            if (solved) return false;
            const column = colOf(activeBlank) - dx;
            const row = rowOf(activeBlank) - dy;
            if (column < 0 || column >= config.cols || row < 0 || row >= config.rows) return false;

            const source = row * config.cols + column;
            if (board[source] === null) return false;

            moveTile(source, activeBlank);
            return true;
        };

        /* --- Arrastar as peças --- */
        let drag = null;            // peça em movimento

        function startDrag(event, tile, label) {
            if (solved || drag || (event.button !== undefined && event.button !== 0)) return;

            const index = board.indexOf(label);
            if (index < 0) return;

            const rect = boardEl.getBoundingClientRect();
            drag = {
                tile,
                index,
                startX: event.clientX,
                startY: event.clientY,
                cellW: rect.width / config.cols,
                cellH: rect.height / config.rows,
                direction: null,
                target: -1,
                offset: 0
            };
            try {
                tile.setPointerCapture(event.pointerId);
            } catch (error) {
                /* ponteiro já liberado: o arrasto continua pelo tabuleiro */
            }
        }

        function moveDrag(event) {
            if (!drag) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;

            // A direção trava no primeiro gesto que aponta para um espaço vazio
            if (!drag.direction && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                const horizontal = { dx: Math.sign(dx), dy: 0 };
                const vertical = { dx: 0, dy: Math.sign(dy) };
                const candidates = Math.abs(dx) >= Math.abs(dy)
                    ? [horizontal, vertical]
                    : [vertical, horizontal];

                for (const candidate of candidates) {
                    if (!candidate.dx && !candidate.dy) continue;
                    const target = blankNext(drag.index, candidate.dx, candidate.dy);
                    if (target >= 0) {
                        drag.direction = candidate;
                        drag.target = target;
                        drag.tile.classList.add('dragging');
                        break;
                    }
                }
            }

            if (!drag.direction) return;

            const limit = drag.direction.dx ? drag.cellW : drag.cellH;
            const along = drag.direction.dx ? dx * drag.direction.dx : dy * drag.direction.dy;
            drag.offset = Math.max(0, Math.min(along, limit));
            drag.tile.style.setProperty('--dx', `${drag.offset * drag.direction.dx}px`);
            drag.tile.style.setProperty('--dy', `${drag.offset * drag.direction.dy}px`);
        }

        function endDrag(event) {
            if (!drag) return;
            const current = drag;
            drag = null;

            if (current.tile.releasePointerCapture && current.tile.hasPointerCapture(event.pointerId)) {
                current.tile.releasePointerCapture(event.pointerId);
            }

            // Solta a animação antes de trocar as posições: a peça segue do ponto
            // onde parou até a casa nova, sem voltar atrás.
            current.tile.classList.remove('dragging');
            current.tile.style.removeProperty('--dx');
            current.tile.style.removeProperty('--dy');

            const limit = current.direction && current.direction.dx ? current.cellW : current.cellH;
            const commit = event.type === 'pointerup' && current.direction && current.offset >= limit * 0.35;
            if (commit) moveTile(current.index, current.target);
        }

        function registerMove(amount) {
            moves += amount;
            if (!startedAt) startTimer();
            positionTiles();
            updateStats();
            checkSolved();
        }

        /* --- Embaralhamento (só movimentos válidos, então sempre tem solução) --- */
        const mixOnce = () => {
            let lastTile = -1;
            const rounds = cellCount() * 40;

            for (let n = 0; n < rounds; n += 1) {
                const blanks = board.reduce((list, value, index) => {
                    if (value === null) list.push(index);
                    return list;
                }, []);
                const blank = blanks[Math.floor(Math.random() * blanks.length)];
                const options = neighbours(blank).filter(i => board[i] !== null && board[i] !== lastTile);
                if (!options.length) continue;

                const source = options[Math.floor(Math.random() * options.length)];
                lastTile = board[source];
                board[blank] = board[source];
                board[source] = null;
            }
        };

        /* --- Ciclo de vida --- */
        function buildStructure() {
            boardEl.innerHTML = '';
            boardEl.style.setProperty('--cols', config.cols);
            boardEl.style.setProperty('--rows', config.rows);

            const layer = document.createElement('div');
            layer.className = 'puzzle-cells';
            cellEls = [];

            for (let i = 0; i < cellCount(); i += 1) {
                const cell = document.createElement('div');
                cell.addEventListener('click', () => {
                    if (board[i] === null && !solved) {
                        activeBlank = i;
                        highlightBlank();
                    }
                });
                layer.appendChild(cell);
                cellEls.push(cell);
            }
            boardEl.appendChild(layer);

            tiles.clear();
            config.labels.forEach((label, n) => {
                const symbol = SYMBOLS[label];
                const tile = document.createElement('button');
                tile.type = 'button';
                tile.className = symbol ? 'puzzle-tile symbol' : 'puzzle-tile';
                tile.dataset.label = label;
                tile.style.setProperty('--i', n);
                tile.innerHTML = `<span>${symbol || label}</span>`;
                // A peça só sai do lugar arrastando (ou pelas setas do teclado)
                tile.addEventListener('pointerdown', event => startDrag(event, tile, label));
                tiles.set(label, tile);
                boardEl.appendChild(tile);
            });
        }

        function positionTiles() {
            board.forEach((label, index) => {
                if (label === null) return;
                const tile = tiles.get(label);
                if (!tile) return;
                tile.style.setProperty('--x', colOf(index));
                tile.style.setProperty('--y', rowOf(index));
                tile.setAttribute(
                    'aria-label',
                    `Peça ${spoken(label)}, linha ${rowOf(index) + 1}, coluna ${colOf(index) + 1}`
                );
            });
            highlightBlank();
        }

        function highlightBlank() {
            cellEls.forEach((cell, index) => {
                cell.classList.toggle('active', !solved && index === activeBlank && board[index] === null);
            });
        }

        function newGame() {
            board = Array.from({ length: cellCount() }, (unused, index) => (
                index < tileCount() ? config.labels[index] : null
            ));

            let guard = 0;
            do {
                mixOnce();
                guard += 1;
            } while (isSolved() && guard < 5);

            activeBlank = board.indexOf(null);
            moves = 0;
            elapsed = 0;
            startedAt = 0;
            solved = false;
            stopTimer();
            boardEl.classList.remove('solved');
            setStatus(`Arraste as peças até deixar o tabuleiro ${goalHint()}.`);
            positionTiles();
            updateStats();
        }

        function setMode(name) {
            if (!MODES[name] || name === mode) return;
            mode = name;
            config = MODES[name];
            modeBtns.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.puzzleMode === name)));
            buildStructure();
            newGame();
            // Cada modo tem o seu próprio recorde: o placar acompanha a troca
            showBest();
        }

        /* --- Cronômetro --- */
        const currentElapsed = () => elapsed + (startedAt ? Date.now() - startedAt : 0);

        function startTimer() {
            if (solved || !visible) return;
            startedAt = Date.now();
            clearInterval(ticker);
            ticker = setInterval(updateStats, 250);
        }

        function stopTimer() {
            if (startedAt) {
                elapsed += Date.now() - startedAt;
                startedAt = 0;
            }
            clearInterval(ticker);
            ticker = 0;
        }

        /* --- Placar --- */
        function updateStats() {
            if (movesEl) movesEl.textContent = moves;
            if (movesLabelEl) movesLabelEl.textContent = moves === 1 ? 'movimento' : 'movimentos';
            if (timeEl) timeEl.textContent = formatTime(currentElapsed());
        }

        function readBest() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_PREFIX + mode) || 'null');
            } catch (error) {
                return null;
            }
        }

        function saveBest(record) {
            try {
                localStorage.setItem(STORAGE_PREFIX + mode, JSON.stringify(record));
            } catch (error) {
                /* localStorage indisponível: o jogo segue normalmente */
            }
        }

        function showBest() {
            if (!bestEl) return;
            const best = readBest();
            bestEl.innerHTML = best
                ? `<i class="fas fa-trophy"></i> Melhor: ${best.moves} mov · ${formatTime(best.ms)}`
                : '';
        }

        function setStatus(text, isWin) {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.classList.toggle('win', Boolean(isWin));
        }

        function checkSolved() {
            if (!isSolved()) return;

            solved = true;
            stopTimer();
            const time = currentElapsed();
            boardEl.classList.add('solved');
            highlightBlank();
            const word = moves === 1 ? 'movimento' : 'movimentos';
            setStatus(`Resolvido em ${moves} ${word} e ${formatTime(time)}!`, true);

            const best = readBest();
            if (!best || moves < best.moves || (moves === best.moves && time < best.ms)) {
                saveBest({ moves, ms: time });
            }
            showBest();
        }

        /* --- Ligações --- */
        // O ponteiro fica capturado pela peça, então os eventos sobem até o tabuleiro
        boardEl.addEventListener('pointermove', moveDrag);
        boardEl.addEventListener('pointerup', endDrag);
        boardEl.addEventListener('pointercancel', endDrag);

        modeBtns.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.puzzleMode)));
        if (shuffleBtn) shuffleBtn.addEventListener('click', newGame);

        document.addEventListener('keydown', event => {
            if (!visible || solved) return;
            const moveBy = {
                ArrowUp: [0, -1],
                ArrowDown: [0, 1],
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0]
            }[event.key];
            if (!moveBy) return;
            event.preventDefault();
            keyMove(moveBy[0], moveBy[1]);
        });

        if (modal) {
            modal.addEventListener('modal:open', () => {
                visible = true;
                showBest();
                // Retoma o cronômetro de uma partida já iniciada
                if (!solved && (moves > 0 || elapsed > 0)) startTimer();
            });
            modal.addEventListener('modal:close', () => {
                visible = false;
                stopTimer();
            });
        } else {
            // Em página própria o jogo está sempre em cena
            visible = true;
        }

        buildStructure();
        newGame();
        showBest();
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-puzzle]').forEach(createPuzzle);
    });
})();
