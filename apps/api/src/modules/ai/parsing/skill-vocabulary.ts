/**
 * The closed vocabulary the rule-based parser matches against (FR3.1).
 *
 * WHY CLOSED. Free extraction — treating capitalised nouns or comma-separated
 * fragments as skills — produces a list a recruiter must then clean, and it
 * cannot distinguish "Python" from "Python Software Foundation" or from a
 * street name. Matching a known list is narrower, but every term it returns is
 * a real skill, and a term it misses is a knowable gap rather than a silent
 * error. That trade is the right way round when the alternative is confident
 * noise.
 *
 * NOT A RANKING INPUT. BR-07 fixes the six features a model may use, and this
 * is not one of them; the list feeds the parsed profile a recruiter reads, not
 * a score. Extending it is a data change with no behavioural risk.
 *
 * Ordered longest-first at match time is unnecessary because matching is
 * whole-token, so "Java" cannot match inside "JavaScript".
 */
export const SKILL_VOCABULARY: readonly string[] = [
  // Languages
  'JavaScript',
  'TypeScript',
  'Python',
  'Java',
  'Kotlin',
  'Swift',
  'Go',
  'Rust',
  'C',
  'C++',
  'C#',
  'Ruby',
  'PHP',
  'Scala',
  'R',
  'MATLAB',
  'Perl',
  'Dart',
  'SQL',
  'PL/SQL',
  'Bash',
  'Shell',
  'PowerShell',
  'HTML',
  'CSS',
  'Sass',

  // Frontend
  'React',
  'React Native',
  'Next.js',
  'Vue',
  'Vue.js',
  'Angular',
  'Svelte',
  'Redux',
  'Tailwind',
  'Tailwind CSS',
  'Bootstrap',
  'jQuery',
  'Webpack',
  'Vite',

  // Backend and API
  'Node.js',
  'Express',
  'NestJS',
  'Django',
  'Flask',
  'FastAPI',
  'Spring',
  'Spring Boot',
  'Laravel',
  'Rails',
  'Ruby on Rails',
  '.NET',
  'ASP.NET',
  'GraphQL',
  'REST',
  'gRPC',
  'Microservices',

  // Data
  'PostgreSQL',
  'MySQL',
  'SQLite',
  'MongoDB',
  'Redis',
  'Elasticsearch',
  'Cassandra',
  'DynamoDB',
  'Oracle',
  'SQL Server',
  'Prisma',
  'Hibernate',
  'Snowflake',
  'BigQuery',
  'Redshift',
  'Kafka',
  'RabbitMQ',
  'Airflow',
  'Spark',
  'Hadoop',
  'dbt',
  'ETL',

  // Cloud and platform
  'AWS',
  'Azure',
  'GCP',
  'Google Cloud',
  'Docker',
  'Kubernetes',
  'Terraform',
  'Ansible',
  'Jenkins',
  'GitHub Actions',
  'GitLab CI',
  'CircleCI',
  'Nginx',
  'Linux',
  'Serverless',
  'Lambda',
  'CloudFormation',

  // ML and analytics
  'Machine Learning',
  'Deep Learning',
  'TensorFlow',
  'PyTorch',
  'Keras',
  'scikit-learn',
  'Pandas',
  'NumPy',
  'NLP',
  'Computer Vision',
  'Tableau',
  'Power BI',
  'Looker',

  // Practice
  'Git',
  'Agile',
  'Scrum',
  'Kanban',
  'CI/CD',
  'TDD',
  'Unit Testing',
  'Jest',
  'Cypress',
  'Playwright',
  'Selenium',
  'JUnit',
  'pytest',
  'Accessibility',
  'WCAG',
  'UX',
  'UI Design',
  'Figma',
  'Project Management',
  'Stakeholder Management',
  'Technical Writing',
];
