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
| Top N | any | adds nested `<groupfilter>` (`end`/`order`/`level-members`) + `computed-sort` |
| Symbol/Filled map | `Automatic` | generated Lat/Long on rows/cols, geo dimension on detail |

## 7. Implications for the compiler

- The LLM never writes this XML. It emits a `WorksheetSpec` (Zod). The compiler
  maps `chartType` -> mark class + placement recipe, resolves each `FieldSpec`
  to a validated pill, and assembles the block above.
- Internal consistency (rows/cols/encoding refs all declared in
  `datasource-dependencies`, all pointing at the locked `dsId`, all fields real)
  is what guarantees the workbook opens in Tableau Desktop.
- The datasource block and `.hyper` are never modified.
