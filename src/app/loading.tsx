import styles from "./help/help.module.css";

export default function Loading() {
  return (
    <div className={styles.page}>
      <section
        className={styles.recovery}
        aria-busy="true"
        aria-label="Loading research view"
      >
        <p className={styles.eyebrow} role="status">
          Loading research view…
        </p>
        <p>
          Preparing this page. Source dates and coverage will appear with the
          results.
        </p>
        <div className={styles.skeleton} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    </div>
  );
}
