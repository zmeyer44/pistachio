import {
  anthropicCard,
  microsoftCard,
  simpleModernCard,
  sweetgreenCard,
  tilesA,
  tilesB,
  tilesC,
  tilesD,
  type LogoTile,
  type StatCard,
} from "../lib/site-data";
import { ArrowUpRight, BrandMark, SectionLabel } from "./primitives";

/** Row height of a grid cell at each breakpoint. */
const CELL = "h-[197px] tab:h-[222px] desk:h-[242px]";

/** One of the four large stat panels seeded through the logo grid. */
function StatPanel({ card }: { card: StatCard }) {
  return (
    <a
      href={card.href}
      className={`group flex flex-col justify-between bg-tile pt-3 pr-3 pb-4 pl-4 transition-colors duration-150 hover:bg-field ${CELL}`}
    >
      <div className="flex items-start justify-between">
        <BrandMark
          name={card.logo}
          label={card.logo}
          width={card.width}
          height={card.height}
          className="mt-1 text-ink"
        />
        <div className="flex flex-col items-end">
          <ArrowUpRight />
          <span className="pr-1.5 text-12 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            Case Study
          </span>
        </div>
      </div>
      <div className="flex flex-col">
        <p className="text-48">{card.stat}</p>
        <p className="text-12">{card.caption}</p>
      </div>
    </a>
  );
}

/** A tile that cross-fades between two brand marks. */
function Tile({ tile, seed }: { tile: LogoTile; seed: number }) {
  return (
    <div className="relative flex items-center justify-center overflow-hidden bg-tile">
      {tile.map((brand, i) => (
        <span
          key={brand.logo}
          className="absolute inset-0 flex items-center justify-center"
          style={{
            animation: `fade-cycle 12s ${seed * -1.5 - (i === 0 ? 0 : 6)}s ease-in-out infinite`,
          }}
        >
          <BrandMark
            name={brand.logo}
            label={brand.logo}
            width={brand.width}
            height={brand.height}
            className="text-ink"
          />
        </span>
      ))}
    </div>
  );
}

/** 2x2 block used at tablet and desktop. */
function TileQuad({ tiles, seed }: { tiles: LogoTile[]; seed: number }) {
  return (
    <div className={`grid grid-cols-2 grid-rows-2 gap-1 ${CELL}`}>
      {tiles.map((t, i) => (
        <Tile key={i} tile={t} seed={seed + i} />
      ))}
    </div>
  );
}

/** Single column of three tiles used on phones — tiles 1, 3 then 2 of the block. */
function TileColumn({ tiles, seed }: { tiles: LogoTile[]; seed: number }) {
  const order = [tiles[0]!, tiles[2]!, tiles[1]!];
  return (
    <div className={`grid flex-1 grid-rows-3 gap-1 ${CELL}`}>
      {order.map((t, i) => (
        <Tile key={i} tile={t} seed={seed + i} />
      ))}
    </div>
  );
}

/**
 * Below 1200px the grid runs one card+tiles pair per row, alternating
 * card-first / tiles-first. Cards take two thirds of the row on phones and
 * half of it from tablet up, where the tile column also becomes a 2x2 block.
 */
function PairRow({
  card,
  tiles,
  seed,
  tilesFirst,
}: {
  card: StatCard;
  tiles: LogoTile[];
  seed: number;
  tilesFirst?: boolean;
}) {
  const panel = (
    <div className="flex-[2] tab:flex-[1]">
      <StatPanel card={card} />
    </div>
  );
  const quad = (
    <>
      <div className="flex-[1] tab:hidden">
        <TileColumn tiles={tiles} seed={seed} />
      </div>
      <div className="hidden flex-[1] tab:block">
        <TileQuad tiles={tiles} seed={seed} />
      </div>
    </>
  );
  return (
    <div className="flex gap-1">
      {tilesFirst ? (
        <>
          {quad}
          {panel}
        </>
      ) : (
        <>
          {panel}
          {quad}
        </>
      )}
    </div>
  );
}

export function TrustedPartners() {
  return (
    <section
      id="import"
      className="shell flex flex-col items-center gap-16 pt-2 pb-20 desk:gap-20"
    >
      <SectionLabel>Switching over</SectionLabel>

      <div className="flex w-full flex-col items-center gap-20">
        <h2 className="w-full text-center text-28 text-ink tab:text-40 desk:max-w-[696px]">
          Bring your pins and sign-ins from the browser you use today
        </h2>

        {/* phone + tablet: one alternating pair per row */}
        <div className="flex w-full flex-col gap-1 desk:hidden">
          <PairRow card={microsoftCard} tiles={tilesA} seed={0} />
          <PairRow card={sweetgreenCard} tiles={tilesB} seed={4} tilesFirst />
          <PairRow card={anthropicCard} tiles={tilesC} seed={8} />
          <PairRow
            card={simpleModernCard}
            tiles={tilesD}
            seed={12}
            tilesFirst
          />
        </div>

        {/* desktop: four across, alternating naturally */}
        <div className="hidden w-full grid-cols-4 gap-1 desk:grid">
          <StatPanel card={microsoftCard} />
          <TileQuad tiles={tilesA} seed={0} />
          <StatPanel card={sweetgreenCard} />
          <TileQuad tiles={tilesB} seed={4} />
          <TileQuad tiles={tilesC} seed={8} />
          <StatPanel card={anthropicCard} />
          <TileQuad tiles={tilesD} seed={12} />
          <StatPanel card={simpleModernCard} />
        </div>
      </div>
    </section>
  );
}
