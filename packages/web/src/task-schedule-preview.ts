import { nextTaskScheduleAt, type Task } from "@homeagent/core";
import { html } from "hono/html";

type Schedule = Pick<Task, "cadence" | "hour" | "dayOfWeek" | "createdAt" | "lastRunAt">;

export function taskScheduleTime(schedule: Schedule, now: number): string {
  const target = nextTaskScheduleAt(schedule, now);
  if (target <= now) return "下次调度检查时";
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(target);
  return time + "（北京时间）";
}

export const firstTaskSchedulePreview = html`<p role="status" data-first-run></p>
  <noscript><p>保存后可在任务详情查看首次预计运行时间，或选择立即运行。</p></noscript>
  <script>{
    const form = document.currentScript.closest('form');
    const output = form.querySelector('[data-first-run]');
    let revision = 0;
    async function update() {
      const current = ++revision;
      const fields = form.elements;
      const selected = fields.space.selectedOptions[0];
      let delivery = '飞书推送已关闭。';
      if (fields.notify.checked && selected && selected.value) {
        const name = selected.textContent.trim();
        delivery = selected.hasAttribute('data-chat-bound')
          ? '完成后向「' + name + '」绑定的飞书会话推送摘要。'
          : '「' + name + '」尚未绑定飞书会话，摘要可在任务详情查看。';
      } else if (fields.notify.checked) {
        delivery = '请选择结果所属空间。';
      }
      if (!fields.enabled.checked) {
        output.textContent = '定时已停用，可在保存后手动运行。' + delivery;
        return;
      }
      output.textContent = '';
      if (!fields.hour.checkValidity() || fields.hour.value === '') return;
      const query = new URLSearchParams({ cadence: fields.cadence.value, hour: fields.hour.value, day: fields.dayOfWeek.value });
      try {
        const response = await fetch('/tasks/first-run?' + query);
        if (!response.ok) throw new Error();
        const time = await response.text();
        if (current === revision) output.textContent = '首次预计运行：' + time + '。' + delivery;
      } catch {
        if (current === revision) output.textContent = '保存后可在任务详情查看首次预计运行时间。' + delivery;
      }
    }
    form.addEventListener('input', function (event) {
      if (['space', 'cadence', 'dayOfWeek', 'hour', 'enabled', 'notify'].includes(event.target.name)) update();
    });
    update();
  }</script>`;
