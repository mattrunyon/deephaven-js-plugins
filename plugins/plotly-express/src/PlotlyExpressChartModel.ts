import type { Layout, Data } from 'plotly.js';
import type {
  dh as DhType,
  ChartData,
  Table,
  TableSubscription,
} from '@deephaven/jsapi-types';
import { ChartModel, ChartUtils, ChartTheme } from '@deephaven/chart';
import Log from '@deephaven/log';
import {
  PlotlyChartWidget,
  applyColorwayToData,
  getDataMappings,
  getWidgetData,
} from './PlotlyExpressChartUtils.js';

const log = Log.module('@deephaven/js-plugin-plotly-express.ChartModel');

export class PlotlyExpressChartModel extends ChartModel {
  constructor(dh: DhType, widget: PlotlyChartWidget, theme = ChartTheme) {
    super(dh);

    this.handleFigureUpdated = this.handleFigureUpdated.bind(this);

    this.widget = widget;
    this.chartUtils = new ChartUtils(dh);
    this.tableColumnReplacementMap = new Map();
    this.chartDataMap = new Map();
    this.tableSubscriptionMap = new Map();

    this.theme = theme;
    this.plotlyLayout = {};
    this.data = [];

    const template = { layout: this.chartUtils.makeDefaultLayout(theme) };

    this.layout = {
      template,
    };

    this.setTitle(this.getDefaultTitle());

    // @ts-ignore
    this.widget.addEventListener(
      'message',
      async ({ detail }: { detail: PlotlyChartWidget }) => {
        this.stopListening();
        await this.init(detail);
        this.startListening();
      }
    );
  }

  widget: PlotlyChartWidget;

  chartUtils: ChartUtils;

  tableSubscriptionMap: Map<Table, TableSubscription>;

  tableSubscriptionCleanups: (() => void)[] = [];

  tableColumnReplacementMap: Map<Table, Map<string, string[]>>;

  chartDataMap: Map<Table, ChartData>;

  theme: typeof ChartTheme;

  data: Data[];

  layout: Partial<Layout>;

  plotlyLayout: Partial<Layout>;

  isListening = false;

  async init(widget: PlotlyChartWidget): Promise<void> {
    this.widget = widget;

    const { figure } = getWidgetData(widget);
    const { plotly, deephaven } = figure;
    const isDefaultTemplate = !deephaven.is_user_set_template;

    this.data = plotly.data;
    this.plotlyLayout = plotly.layout ?? {};

    const template = { layout: this.chartUtils.makeDefaultLayout(this.theme) };

    // For now we will only use the plotly theme colorway since most plotly themes are light mode
    if (!isDefaultTemplate) {
      template.layout.colorway =
        this.plotlyLayout.template?.layout?.colorway ??
        template.layout.colorway;
    }

    this.layout = {
      ...this.plotlyLayout,
      template,
    };

    applyColorwayToData(
      this.layout?.template?.layout?.colorway ?? [],
      this.plotlyLayout?.template?.layout?.colorway ?? [],
      this.data
    );

    const tableColumnReplacementMap = await getDataMappings(widget);
    this.tableColumnReplacementMap = new Map(tableColumnReplacementMap);
  }

  override getData(): Partial<Data>[] {
    return this.data;
  }

  override getLayout(): Partial<Layout> {
    return this.layout;
  }

  override subscribe(callback: (event: CustomEvent) => void): void {
    super.subscribe(callback);

    this.startListening();
  }

  override unsubscribe(callback: (event: CustomEvent) => void): void {
    super.unsubscribe(callback);

    this.stopListening();
  }

  handleFigureUpdated(
    event: CustomEvent,
    chartData: ChartData | undefined,
    columnReplacements: Map<string, string[]> | undefined
  ): void {
    if (chartData == null || columnReplacements == null) {
      log.warn(
        'Unknown chartData or columnReplacements for this event. Skipping update'
      );
      return;
    }
    const { detail: figureUpdateEvent } = event;
    chartData.update(figureUpdateEvent);

    columnReplacements.forEach((destinations, column) => {
      const columnData = chartData.getColumn(
        column,
        val => this.chartUtils.unwrapValue(val),
        figureUpdateEvent
      );
      destinations.forEach(destination => {
        // The JSON pointer starts w/ /plotly and we don't need that part
        const parts = destination
          .split('/')
          .filter(part => part !== '' && part !== 'plotly');
        // eslint-disable-next-line @typescript-eslint/no-this-alias, @typescript-eslint/no-explicit-any
        let selector: any = this;
        for (let i = 0; i < parts.length; i += 1) {
          if (i !== parts.length - 1) {
            selector = selector[parts[i]];
          } else {
            selector[parts[i]] = columnData;
          }
        }
      });
    });

    const { data } = this;

    if (this.isListening) {
      this.fireUpdate(data);
    }
  }

  async startListening(): Promise<void> {
    const { dh } = this;

    if (this.tableColumnReplacementMap.size === 0) {
      await this.init(this.widget);
    }

    this.tableColumnReplacementMap.forEach((_, table) =>
      this.chartDataMap.set(table, new dh.plot.ChartData(table))
    );

    this.tableColumnReplacementMap.forEach((columnReplacements, table) => {
      const columnNames = new Set(columnReplacements.keys());
      const columns = table.columns.filter(({ name }) => columnNames.has(name));
      this.tableSubscriptionMap.set(table, table.subscribe(columns));
    });

    this.tableSubscriptionMap.forEach((sub, table) => {
      this.tableSubscriptionCleanups.push(
        sub.addEventListener(this.dh.Table.EVENT_UPDATED, e =>
          this.handleFigureUpdated(
            e,
            this.chartDataMap.get(table),
            this.tableColumnReplacementMap.get(table)
          )
        )
      );
    });

    this.isListening = true;
  }

  stopListening(): void {
    this.isListening = false;
    this.tableSubscriptionCleanups.forEach(cleanup => cleanup());
    this.tableSubscriptionMap.forEach(sub => sub.close());
    this.chartDataMap.clear();
    this.tableSubscriptionMap.clear();
    this.tableSubscriptionCleanups = [];
  }

  getPlotWidth(): number {
    if (!this.rect || !this.rect.width) {
      return 0;
    }

    return Math.max(
      this.rect.width -
        (this.layout.margin?.l ?? 0) -
        (this.layout.margin?.r ?? 0),
      0
    );
  }

  getPlotHeight(): number {
    if (!this.rect || !this.rect.height) {
      return 0;
    }

    return Math.max(
      this.rect.height -
        (this.layout.margin?.t ?? 0) -
        (this.layout.margin?.b ?? 0),
      0
    );
  }
}

export default PlotlyExpressChartModel;
