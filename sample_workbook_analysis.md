# Sample Workbook Analysis

Analysis of `sample_workbook.twbx`, used as the **real Tableau XML reference**
for TableauPilot AI's deterministic worksheet compiler (spec sections 37-39, 89).

The extracted worksheet blocks live in [`templates/sample-1/`](templates/sample-1)
and the chart-type mapping in [`templates/registry/`](templates/registry).

## 1. Workbook facts

| Property | Value |
|----------|-------|
| Format | TWBX (zip: one `.twb` + `Data/Datasources/*.hyper`) |
| Tableau version | 2026.1 (build `20261.26.0410.0924`) |
| XML `version` / `original-version` | `18.1` |
| Source platform | mac |
| Datasources | 1 |
| Worksheets | 20 |
| Dashboards | 0 |

## 2. Datasource (single source of truth)

| Property | Value |
|----------|-------|
| Caption | `Orders+ (Sample - APAC Superstore)` |
| Internal id | `federated.10qdv2g11ishnn1d8ylfn1hvu2ys` |
| Top-level class | `federated` |
| Named connection | `excel-direct` (`Sample - APAC Superstore.xls`) |
| Mode | Extract (embedded `.hyper`) |

The datasource block is preserved byte-for-byte; the `.hyper` under `Data/` is
copied unchanged into the output TWBX. See [`templates/sample-1/datasource.xml`](templates/sample-1/datasource.xml).

## 3. Fields (from `<metadata-record>` + `<column>` declarations)

Representative fields available for worksheet building (dimensions and measures):

- Dimensions: `Order ID`, `Order Date` (date), `Ship Date` (date), `Ship Mode`,
  `Customer ID`, `Customer Name`, `Segment`, `City`, `State`, `Country/Region`,
  `Region`, `Category`, `Sub-Category`, `Product ID`, `Product Name`, `Person`.
- Measures: `Sales` (real, currency default-format), `Profit` (real),
  `Discount` (real), `Quantity` (integer), `Row ID` (integer).

Fields carry: `datatype` (`string|integer|real|date|datetime|boolean`), `role`
(`dimension|measure`), and sometimes `semantic-role` (geographic) or
`default-format` (e.g. `Sales` currency). Field validation uses ONLY these actual
fields (spec section 45).

## 4. Worksheet XML structure (the compiler target)

Every worksheet follows this deterministic shape:

```
<worksheet name='...'>
  <table>
    <view>
      <datasources><datasource caption=... name=<dsId> /></datasources>
      <datasource-dependencies datasource=<dsId>>
        <column .../>            <!-- one per referenced field -->
        <column-instance .../>   <!-- one per referenced pill -->
      </datasource-dependencies>
      [<filter> ...]             <!-- categorical / quantitative / Top-N -->
      [<slices><column>...] 
      <aggregation value='true' />
    </view>
    <style>...</style>
    <panes>
      <pane>
        <mark class='...' />
        <encodings> <color|size|text|lod|shape|wedge-size .../> </encodings>
        [<customized-label>...]  <!-- KPI / pie labels -->
      </pane>
    </panes>
    <rows>...</rows>
    <cols>...</cols>
  </table>
  <simple-id uuid='{...}' />
</worksheet>
```

Each worksheet also requires a registration entry in the `<windows>` section:

```
<window class='worksheet' name='...'>
  <cards>...</cards>
</window>
```

## 5. Column-instance naming rule (deterministic)

Pills are referenced as `[<dsId>].[<deriv>:<Field>:<typekey>]`:

| Kind | Instance name | `derivation` attr | `type` attr |
|------|---------------|-------------------|-------------|
| Dimension (nominal) | `[none:Category:nk]` | `None` | `nominal` |
| Measure SUM | `[sum:Sales:qk]` | `Sum` | `quantitative` |
| Measure AVG/CNT/... | `[avg:...]`,`[cnt:...]` | `Avg`,`Count` | `quantitative` |
| Date year (discrete) | `[yr:Order Date:ok]` | `Year` | `ordinal` |
| Date month-year | `[my:Order Date:ok]` | `MY` | `ordinal` |
| Date continuous trunc | `[tyr:Order Date:qk]`, `[tmn:...:qk]` | `Year-Trunc`,`Month-Trunc` | `quantitative` |
| % of total (table calc) | `[pcto:sum:Profit:qk]` | `Sum` + `<table-calc type='PctTotal'/>` | `quantitative` |

Type key suffixes: `nk` nominal, `ok` ordinal, `qk` quantitative. The compiler
generates the `<column-instance>` declaration and the rows/cols/encoding pill
reference from the same function so they are always consistent.

## 6. Chart-type patterns observed (20 worksheets)

| Chart | Mark class | Key placement |
|-------|-----------|----------------|
| Vertical/Horizontal bar | `Bar`/`Automatic` | measure vs dimension on rows/cols |
| Stacked / side-by-side bar | `Bar` | + dimension on `color` (stacked) |
| Line / dual line | `Line`/`Automatic` | date (continuous) on cols, measure on rows; dual = 2 measures + Measure Names |
| Area | `Area` | like line with area mark |
| Scatter | `Shape`/`Circle` | measure on rows AND cols, dimension on color/detail |
| Pie / Donut | `Pie` | dimension on color, measure on `wedge-size` |
| Text table | `Automatic` | dimensions on rows/cols, measures on `text` |
| Highlight table / heatmap | `Square` | measure on `color` |
| Treemap | `Automatic` (breakdown on) | measure on size+color, dimension on text |
| KPI | `Automatic` | empty rows/cols, measure on `text` + `customized-label` |
| Histogram | `Bar` | measure bin dimension on cols, count on rows |
| Bubble | `Circle` | dimension on color/detail, measure on size |
| Top N | any | adds nested `<groupfilter>` (`end`/`order`/`level-members`) — selection + ordering in the filter (no separate `computed-sort`, see 6b) |
| Symbol/Filled map | `Automatic` | generated Lat/Long on rows/cols, geo dimension on detail |

## 6b. Filter XML patterns (from the sample)

Filters live inside `<view>` (before `<aggregation>`), and every filtered
dimension is also registered under `<slices>`. The `column`/`level` always use the
same **column-instance** name as the pill (e.g. `none:Category:nk`, `yr:Order Date:ok`).

| Filter | Structure |
|--------|-----------|
| Single categorical member | `<filter class='categorical' column='[ds].[none:Category:nk]'>` → one `<groupfilter function='member' level='[none:Category:nk]' member='&quot;Furniture&quot;' user:ui-domain='database' user:ui-enumeration='inclusive' user:ui-marker='enumerate' />` |
| **Multiple** categorical members | one `<groupfilter function='union' …>` wrapping one `<groupfilter function='member' …/>` per value. **Sibling `member` nodes without a `union` are invalid and cause open errors.** |
| Date part (year) | column-instance uses the discrete date part: `[yr:Order Date:ok]`, `member='2026'` (**unquoted**). Month is `[my:Order Date:ok]`/`[mn:…]`, quarter `[qr:…]`, etc. |
| Measure range | `<filter class='quantitative' column='[ds].[sum:Sales:qk]' included-values='in-range'>` with `<min>`/`<max>`. |
| Top N | nested `<groupfilter>` (`end` → `order` → `level-members`). The inner `function='order'` groupfilter selects **and** orders the top/bottom N by the measure. |

> **Do not** emit a standalone in-view `<computed-sort>` for Top-N (even though the
> raw sample contains one and it passes the published TWB XSD). Some Tableau
> runtimes validate the worksheet `<view>` against a stricter schema and reject it
> with `no declaration found for element 'computed-sort'`, which makes the whole
> workbook fail to open. The Top-N filter's `function='order'` groupfilter already
> carries the ordering, so the element is redundant for selection.

Member quoting rule: **string** members are wrapped in `&quot;…&quot;`; **numeric,
boolean, and date-part** members are written bare (`2026`, `12`, `true`).

## 7. Advanced feature XML patterns (from the sample)

**Per-member colors** (pane `<style>`): a dimension gets a discrete palette.
```xml
<style-rule element='mark'>
  <encoding attr='color' field='[none:State:nk]' type='palette'>
    <map to='#499894'><bucket>&quot;Bali&quot;</bucket></map>
    ...
  </encoding>
</style-rule>
```
Measure-on-color = automatic gradient (just place the measure on the color shelf).

**Reference / average line** (sibling under `<pane>`, after `<encodings>`):
```xml
<reference-line axis-column='[ds].[sum:Sales:qk]' enable-instant-analytics='true'
  formula='average' id='refline0' label-type='automatic' scope='per-table'
  value-column='[ds].[sum:Sales:qk]' z-order='1' />
```

**Grand totals**: `total='true'` on the shelf elements — `<rows total='true'>…</rows>`
and `<cols total='true'>…</cols>`.

**Discrete vs continuous**: the column-instance `type` + key encode it —
`type='quantitative'` → `:qk` (continuous/green), `type='ordinal'` → `:ok`,
`type='nominal'` → `:nk` (discrete/blue). Continuous date parts use a `t*` code +
`*-Trunc` derivation (e.g. `tmn:Order Date:qk` derivation `Month-Trunc`); discrete
parts use `mn:Order Date:ok` derivation `Month`.

**Parameters**: stored in a pseudo-datasource; referenced by internal name.
```xml
<datasource hasconnection='false' inline='true' name='Parameters' version='18.1'>
  <column caption='Top N' datatype='integer' name='[Parameter 1]'
    param-domain-type='any' role='measure' type='quantitative' value='5'>
    <calculation class='tableau' formula='5' />
  </column>
</datasource>
```
Parameter-driven Top-N uses the parameter as the count, plus a per-worksheet
`<datasource-dependencies datasource='Parameters'>` re-declaring the column:
```xml
<groupfilter count='[Parameters].[Parameter 1]' end='top' function='end' units='records' ...>
```

**Dashboard filter action** (workbook-level `<actions>`, before `<worksheets>`):
```xml
<action caption='Filter on dashboard' name='[Action1_<32hex>]'>
  <activation auto-clear='true' type='on-select' />
  <source dashboard='<dash>' type='sheet'>
    <exclude-sheet name='<kpi sheet>' />
  </source>
  <command command='tsc:tsl-filter'>
    <param name='special-fields' value='all' />
    <param name='target' value='<dash>' />
  </command>
</action>
```

**Dashboard layout / padding / border / colors** — every dashboard zone carries a
`<zone-style>`. The root `layout-basic` zone's `margin` is the OUTER padding; each
inner zone's `margin` is the INNER padding. Container background + border live here
too. The dashboard color is a `<style-rule element='table'>` on the dashboard.
```xml
<!-- dashboard color -->
<style><style-rule element='table'>
  <format attr='background-color' value='#e6e6e6' /></style-rule></style>
<!-- a chart container zone-style -->
<zone-style>
  <format attr='border-color' value='#000000' />
  <format attr='border-style' value='none' />
  <format attr='border-width' value='0' />
  <format attr='margin' value='4' />            <!-- inner padding -->
  <format attr='background-color' value='#ffffff' /> <!-- container color -->
</zone-style>
```

**Dashboard sizing** — the `<size>` element (three Tableau modes). The sample uses
automatic + fixed; range follows the same shape with `sizing-mode='range'` and
min < max:
```xml
<size sizing-mode='automatic' />                                   <!-- automatic -->
<size maxheight='1500' maxwidth='1200' minheight='1500' minwidth='1200' sizing-mode='fixed' />
<size maxheight='1050' maxwidth='1400' minheight='600'  minwidth='800'  sizing-mode='range' />
```
Container sizes come from the proportional zone `w`/`h` in the 0-100000 space; the
compiler derives them from per-cell `width` / per-row `height` (px on fixed/range,
weights on automatic).

**Title / heading text formatting** — the title band and filter heading are `text`
zones whose `<run>` carries the font attributes (alignment 0=left/1=center/2=right):
```xml
<formatted-text>
  <run bold='true' fontalignment='1' fontcolor='#1b1b1b'
    fontname='Tableau Bold' fontsize='16'>Superstore Analysis</run>
</formatted-text>
```

**Sheet (worksheet) title formatting** — a WORKSHEET-level property, not a dashboard
one; the dashboard just renders it. Placed right after `<worksheet name=...>`, before
`<table>`:
```xml
<layout-options>
  <title><formatted-text>
    <run fontcolor='#0044cc' fontsize='14'>Category Performance</run>
  </formatted-text></title>
</layout-options>
```

## 8. Implications for the compiler

- The LLM never writes this XML. It emits a `WorksheetSpec` (Zod). The compiler
  maps `chartType` -> mark class + placement recipe, resolves each `FieldSpec`
  to a validated pill, and assembles the block above.
- Internal consistency (rows/cols/encoding refs all declared in
  `datasource-dependencies`, all pointing at the locked `dsId`, all fields real)
  is what guarantees the workbook opens in Tableau Desktop.
- The datasource block and `.hyper` are never modified. Parameters live in the
  separate `Parameters` pseudo-datasource, parallel to calculated fields.
