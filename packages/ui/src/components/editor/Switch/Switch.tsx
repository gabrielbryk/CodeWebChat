import React from 'react'
import styles from './Switch.module.scss'
import cn from 'classnames'

type Props = {
  value: 'Web' | 'API'
  onChange: (value: 'Web' | 'API') => void
}

export const Switch: React.FC<Props> = (props) => {
  return (
    <div className={styles.container}>
      <div
        className={cn(styles.option, {
          [styles['option--active']]: props.value == 'Web'
        })}
        onClick={() => props.onChange('Web')}
        data-text="Web"
      >
        Web
      </div>
      <div
        className={cn(styles.option, {
          [styles['option--active']]: props.value == 'API'
        })}
        onClick={() => props.onChange('API')}
        data-text="API"
      >
        API
      </div>
    </div>
  )
}
