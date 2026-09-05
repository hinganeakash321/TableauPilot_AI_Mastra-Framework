# Sample Dashboard Analysis

Reference patterns extracted from the two dashboards in `sample_workbook.twbx`
(`Sample Dashboard Automatic size` and `Sample Dashboard Fixed size`). These drive
the deterministic dashboard compiler (`src/tableau/compiler/dashboardCompiler.ts`)
and the apply-to-all filter injector (`src/tableau/compiler/dashboardFilters.ts`).
The extracted XML lives in `templates/sample-1/dash_*.xml` and
`templates/sample-1/win_dash_*.xml`.

The LLM never emits any of this XML - it only produces a validated `DashboardSpec`
(`src/mastra/schemas/dashboard.ts`).

## Dashboard element (`<dashboard>` inside `<dashboards>`)

```
<dashboard enable-sort-zone-taborder='true' name='Sample Dashboard Automatic size'>
  <style>
    <style-rule element='table'>
      <format attr='background-color' value='#e6e6e6' />   <!-- board background -->
    </style-rule>
  </style>
  <size sizing-mode='automatic' />                          <!-- OR fixed, see below -->
  <datasources>
    <datasource caption='...' name='federated.<id>' />
  </datasources>
  <datasource-dependencies datasource='federated.<id>'>     <!-- one per filter field -->
    <column .../> ... <column-instance .../> ...
  </datasource-dependencies>
  <zones> ... </zones>
  <devicelayouts> <devicelayout auto-generated='true' name='Phone'>...</devicelayout> </devicelayouts>
  <simple-id uuid='{...}' />
</dashboard>
```

- **Background**: `<style-rule element='table'>` -> `background-color = #e6e6e6`.
- **Sizing**:
  - Automatic: `<size sizing-mode='automatic' />`.
  - Fixed: `<size maxheight='1200' maxwidth='1200' minheight='1200' minwidth='1200' sizing-mode='fixed' />`.
- **datasource-dependencies**: every filter field's `<column>` + `<column-instance>`
  declarations (same shapes the worksheet compiler emits).
- **devicelayouts**: the sample carries an auto-generated Phone layout. Tableau
  regenerates this on open, so the compiler OMITS it (optional, reduces risk).
- **layout-cache**: worksheet zones in the sample carry a `<layout-cache/>` hint.
  It is a cache Tableau regenerates, so the compiler OMITS it.

## Zone tree (`<zones>`, coordinate space 0-100000)

```
layout-basic (root, zone-style margin 8)
  layout-flow vert (outer)
    layout-flow vert  is-fixed fixed-size='50'   -> title band
      text  ->  <run bold fontname='Tableau Bold' fontsize='16' fontcolor='#1b1b1b'>TITLE</run>
    layout-flow horz  (content)
      layout-flow vert (left charts column)
        layout-flow horz (row)                    -> one per grid row
          layout-flow horz (cell, zone-style bg #ffffff)
            <zone name='Sheet' [show-title='false']>   -> worksheet zone
      layout-flow vert  is-fixed fixed-size='200' (Filters panel, zone-style bg #ffffff)
        text  is-fixed fixed-size='42'            -> "Filters" heading (Tableau Semibold 12)
        filter ...                                -> one per filter field
        empty                                     -> spacer fills the rest
```

- **Every zone** has a `<zone-style>` with `border-style none`, `border-width 0`,
  `border-color #000000`, `margin 4`.
- **Containers** that show a white card add `background-color = #ffffff` (chart
  cells and the Filters panel).
- **Worksheet zones** are `<zone ... name='<worksheet name>'>` (no `type-v2`). They
  must reference an existing worksheet by its exact name. `show-title='false'`
  hides the sheet caption.
- **Title band** and **Filters panel** are the only `is-fixed` containers
  (`fixed-size='50'` for the title, `fixed-size='200'` for the panel). Everything
  else is flow layout, which Tableau reflows on open - so exact pixel coordinates
  are NOT required, only a consistently-tiled tree.

## Filter zones (the right-side Filters panel)

```
<zone h w x y id
      mode='checkdropdown'          <!-- multiple-selection dropdown -->
      name='Sample KPI Chart'       <!-- source worksheet the control is anchored to -->
      param='[federated.<id>].[none:Region:nk]'   <!-- the column-instance it controls -->
      show-apply='true'             <!-- Apply button (deferred update) -->
      type-v2='filter'
      values='relevant'>            <!-- relevant values; DATE fields use 'database' -->
  <zone-style> border none, margin 4 </zone-style>
</zone>
```

- Categorical dimension filters use `values='relevant'`.
- The date filter uses a discrete part instance (`[my:Order Date:ok]` in the
  sample) and `values='database'`. Our compiler defaults date filter fields to a
  YEAR part (`[yr:<field>:ok]`) with `values='database'`.
- `name=` is the SAME source worksheet for every control (the first sheet on the
  board by default; override via `filters.sourceWorksheet`).

## "Apply to Worksheets -> All Using This Data Source" (NOT stored on the dashboard)

This is the key insight. The dashboard filter control does not carry the
apply-to-all setting. Instead, **each filter field is written as a shared context
filter on every worksheet that uses the datasource**, tied together by a common
`filter-group`:

```
<filter class='categorical' column='[federated.<id>].[none:Region:nk]'
        context='true' filter-group='N'>
  <groupfilter function='level-members' level='[none:Region:nk]'
               user:ui-enumeration='all' user:ui-marker='enumerate' />
</filter>
```

- The same `filter-group='N'` on the same column across worksheets is what makes
  Tableau treat the control as one dashboard-wide filter applied to all sheets.
- `context='true'` matches the sample (the applied filters are context filters).
- Default **select-all** = `function='level-members' ... user:ui-enumeration='all'`.
- The injector (`dashboardFilters.injectApplyToAllFilters`) also ensures each
  worksheet's `<datasource-dependencies>` contains the field's `<column>` +
  `<column-instance>` declarations, and picks `filter-group` numbers above the
  current maximum in the TWB to avoid collisions.

## Window (`<window class='dashboard'>` inside `<windows>`)

```
<window class='dashboard' name='Sample Dashboard Automatic size'>
  <viewpoints>
    <viewpoint name='Sample KPI Chart'><zoom type='entire-view' /></viewpoint>
    ...                                        <!-- one per contained worksheet -->
  </viewpoints>
  <active id='-1' />
  <simple-id uuid='{...}' />
</window>
```

## Fixed vs automatic (the two samples)

| Aspect            | Automatic size                         | Fixed size                                  |
| ----------------- | -------------------------------------- | ------------------------------------------- |
| `<size>`          | `sizing-mode='automatic'`              | `sizing-mode='fixed'` min/max 1200 x 1200   |
| Background        | `#e6e6e6`                              | `#e6e6e6`                                    |
| Filters panel     | fixed 200px, checkdropdown + Apply     | fixed 200px, checkdropdown + Apply          |
| Chart containers  | white (`#ffffff`), flow grid           | white (`#ffffff`), flow grid                |
| Layout            | Tableau reflows on open                | Tableau reflows within the fixed canvas     |

Both are reproduced by `compileDashboard` from a `DashboardSpec` (`sizeMode`,
`width`/`height`, `rows`, `filters`), and both build/modify through the same
`applyDashboards` + `injectApplyToAllFilters` pipeline.
